///<reference path="../utils.ts"/>
///<reference path="../../common/models.ts"/>

const crypto = require('crypto');

import Utils = require("../utils");
import _ = require('lodash');
import request = require('request');
import Models = require("../../common/models");
import log from "../logging";
import * as coinbase from './coinbase';

const HttpsAgent = require('agentkeepalive').HttpsAgent;
import * as EventEmitter from 'events';
import WebSocket = require('ws');

const coinbaseLog = log("tribeca:gateway:coinbase-api");

export class PublicClient {
    constructor(public apiURI: string) {
        coinbaseLog.info("starting coinbase public client, apiURI = ", apiURI);
    }

    public addHeaders(obj, additional) {
        obj.headers = obj.headers || {};
        return _.assign(obj.headers, {
            'User-Agent': 'coinbase-node-client',
            'Accept': 'application/json',
            'Content-Type': 'application/json',
        }, additional);
    };

    public makeRelativeURI(parts) {
        return '/' + parts.join('/');
    };

    public makeAbsoluteURI(relativeURI) {
        return this.apiURI + relativeURI;
    };

    public makeRequestCallback(callback) {
        return function(err, response, data) {
            if (typeof data === "string") {
                data = JSON.parse(data);
            }
            callback(err, response, data);
        };
    };

    public request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', uriParts: (string | number)[],
        opts: (request.UriOptions & request.CoreOptions) | (request.UrlOptions & request.CoreOptions), callback?: Function) {

        _.assign(opts, {
            'method': method.toUpperCase(),
            'uri': this.makeAbsoluteURI(this.makeRelativeURI(uriParts)),
            'json': true,
        });
        this.addHeaders(opts, {});
        opts.agent = new HttpsAgent();
        request(opts, this.makeRequestCallback(callback));
    };

    public getProducts(callback) {
        return this.request('GET', ['products'], callback);
    };

    public getProductOrderBook(productID: number, level, callback) {
        if (!callback && (level instanceof Function)) {
            callback = level;
            level = null;
        }
        var opts = level && { 'qs': { 'level': level } };
        return this.request('GET', ['products', productID, 'book'], opts as any, callback);
    };

    public getProductTicker(productID, callback) {
        return this.request('GET', ['products', productID, 'ticker'], callback);
    };

    public getProductTrades(productID, callback) {
        return this.request('GET', ['products', productID, 'trades'], callback);
    };

    public getProductHistoricRates(productID, callback) {
        return this.request('GET', ['products', productID, 'candles'], callback);
    };

    public getProduct24HrStats(productID, callback) {
        return this.request('GET', ['products', productID, 'stats'], callback);
    };

    public getCurrencies(callback) {
        return this.request('GET', ['currencies'], callback);
    };

    public getTime(callback) {
        return this.request('GET', ['time'], callback);
    };
}

export class AuthenticatedClient extends PublicClient {
    constructor(private key: string, private b64secret: string, private passphrase: string, apiURI: string) {
        super(apiURI);
    }

    public request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', uriParts: (string | number)[],
        opts: (request.UriOptions & request.CoreOptions) | (request.UrlOptions & request.CoreOptions), callback?: Function) {
        var relativeURI = this.makeRelativeURI(uriParts);
        _.assign(opts, {
            'method': method,
            'uri': this.makeAbsoluteURI(relativeURI),
        });
        if (opts.body && (typeof opts.body !== 'string')) {
            opts.body = JSON.stringify(opts.body);
        }
        var timestamp = Date.now() / 1000;
        var what = timestamp + method + relativeURI + (opts.body || '');
        var key = new Buffer(this.b64secret, 'base64');
        var hmac = crypto.createHmac('sha256', key);
        var signature = hmac.update(what).digest('base64');
        this.addHeaders(opts, {
            'CB-ACCESS-KEY': this.key,
            'CB-ACCESS-SIGN': signature,
            'CB-ACCESS-TIMESTAMP': timestamp,
            'CB-ACCESS-PASSPHRASE': this.passphrase,
        });
        request(opts, this.makeRequestCallback(callback));
    };

    public getAccounts(callback) {
        return this.request('GET', ['accounts'], callback);
    };

    public getAccount(accountID, callback) {
        return this.request('GET', ['accounts', accountID], callback);
    };

    public getAccountHistory(accountID, callback) {
        return this.request('GET', ['accounts', accountID, 'ledger'], callback);
    };

    public getAccountHolds(accountID, callback) {
        return this.request('GET', ['accounts', accountID, 'holds'], callback);
    };

    public _placeOrder(params, callback) {
        _.forEach(['size', 'side', 'product_id'], function(param) {
            if (params[param] === undefined) {
                throw new Error("`opts` must include param `" + param + "`");
            }
        });
        var opts = { 'body': params };
        return this.request('POST', ['orders'], opts as any, callback);
    };

    public buy(params, callback) {
        params.side = 'buy';
        return this._placeOrder(params, callback);
    };

    public sell(params, callback) {
        params.side = 'sell';
        return this._placeOrder(params, callback);
    };

    public cancelOrder(orderID, callback) {
        return this.request('DELETE', ['orders', orderID], callback);
    };
    
    public cancelAllOrders(callback) {
        return this.request('DELETE', ['orders'], callback);
    };

    public getOrders(callback) {
        return this.request('GET', ['orders'], callback);
    };

    public getOrder(orderID, callback) {
        return this.request('GET', ['orders', orderID], callback);
    };

    public getFills(callback) {
        return this.request('GET', ['fills'], callback);
    };

    public deposit(params, callback) {
        params.type = 'deposit';
        return this._transferFunds(params, callback);
    };

    public withdraw(params, callback) {
        params.type = 'withdraw';
        return this._transferFunds(params, callback);
    };

    public _transferFunds(params: { type, amount, coinbase_account_id } | string, callback: Function) {
        var opts = { 'body': params };
        return this.request('POST', ['transfers'], opts as any, callback);
    };

};

enum STATES {
    closed,
    open,
    syncing,
    processing,
    error,
};

export class OrderBook extends EventEmitter {
    queue: number[];
    book: coinbase.CoinbaseBookStorage;
    socket: WebSocket;
    state: string;
    fail_count: number = 0;
    constructor(public productID: string, public websocketURI: string,
                public restURI: string, public timeProvider: Utils.ITimeProvider) {
        super();
        this.connect();
    }

    public clear_book() {
        this.queue = [];
        this.book = {
            'sequence': null,
            'bids': {},
            'asks': {},
        };
    };

    public connect() {
        coinbaseLog.info("Starting connect");
        if (this.socket) {
            this.socket.close();
        }
        this.clear_book();
        this.socket = new WebSocket(this.websocketURI);
        this.socket.on('message', this.onMessage.bind(this));
        this.socket.on('open', this.onOpen.bind(this));
        this.socket.on('close', this.onClose.bind(this));
    };

    public disconnect() {
        if (!this.socket) {
            throw new Error("Could not disconnect (not connected)");
        }
        this.socket.close();
        this.onClose();
    };

    public changeState(stateName: STATES) {
        const oldState = this.state as unknown as STATES;
        this.state = stateName as unknown as string;

        if (this.fail_count > 3)
            throw new Error("Tried to reconnect 4 times. Giving up.");

        if (stateName === STATES.error || stateName === STATES.closed) {
            this.fail_count += 1;
            this.socket.close();
            setTimeout(() => this.connect(), 5000);
        }
        else if (stateName === STATES.processing) {
            this.fail_count = 0;
        }

        var sc = { 'old': oldState, 'new': stateName };
        coinbaseLog.info("statechange: ", sc);
        this.emit('statechange', sc);
    };

    public onOpen() {
        this.changeState(STATES.open);
        this.sync();
    };

    public onClose() {
        this.changeState(STATES.closed);
    };

    public onMessage(datastr: string) {
        var t = this.timeProvider.utcNow();
        var data = JSON.parse(datastr);
        if (this.state as unknown as STATES !== STATES.processing) {
            this.queue.push(data);
        } else {
            this.processMessage(data, t);
        }
    };

    public sync() {
        this.changeState(STATES.syncing);
        var subscribeMessage = {
            'type': 'subscribe',
            'product_id': this.productID,
        };
        this.socket.send(JSON.stringify(subscribeMessage));
        this.loadSnapshot();
    };

    public loadSnapshot() {

        var load = function(data) {
            var i, bid, ask;
            var convertSnapshotArray = function(array) {
                return { 'price': array[0], 'size': array[1], 'id': array[2] }
            };

            for (i = 0; data.bids && i < data.bids.length; i++) {
                bid = convertSnapshotArray(data.bids[i]);
                this.book.bids[bid.id] = bid;
            }
            ;
            for (i = 0; data.asks && i < data.asks.length; i++) {
                ask = convertSnapshotArray(data.asks[i]);
                this.book.asks[ask.id] = ask;
            }
            ;
            this.book.sequence = data.sequence
            this.changeState(STATES.processing);
            _.forEach(this.queue, this.processMessage.bind(this));
            this.queue = [];
        };

        request({
            'url': this.restURI + '/products/' + this.productID + '/book?level=3',
            'headers': { 'User-Agent': 'coinbase-node-client' },
        }, function(err, response, body) {
                if (err) {
                    this.changeState(STATES.error);
                    coinbaseLog.error(err, "error: Failed to load snapshot");
                }
                else if (response.statusCode !== 200) {
                    this.changeState(STATES.error);
                    coinbaseLog.error("Failed to load snapshot", response.statusCode);
                }
                else {
                    load(JSON.parse(body));
                }
            });
    };

    public processMessage(message, t: Date) {
        if (message.sequence <= this.book.sequence) {
            this.emit('ignored', message);
            return;
        }
        if (message.sequence != this.book.sequence + 1) {
            this.changeState(STATES.error);
            coinbaseLog.warn("Received message out of order, expected", this.book.sequence, "but got", message.sequence);
        }
        this.book.sequence = message.sequence;

        this.emit(message.type, new Models.Timestamped(message, t));
    };
};
