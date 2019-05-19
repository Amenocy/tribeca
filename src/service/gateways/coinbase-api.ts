import * as crypto from 'crypto';
import Utils = require("../utils");
import _ = require('lodash');
import request = require('request');
import Models = require("../../common/models");
import log from "../logging";
import * as coinbase from './coinbase';

const HttpsAgent = require('agentkeepalive').HttpsAgent;
import * as EventEmitter from 'events';
import WebSocket = require('ws');

type RequestOptions = (request.UriOptions & request.CoreOptions) | (request.UrlOptions & request.CoreOptions);
interface GenericObject {[K: string]: string | number | GenericObject };

const coinbaseLog = log("tribeca:gateway:coinbase-api");

export class PublicClient {
    public constructor(public apiURI: string) {
        coinbaseLog.info("starting coinbase public client, apiURI = ", apiURI);
    }

    public addHeaders(obj: GenericObject, additional: GenericObject): RequestOptions {
        obj.headers = obj.headers || {};
        _.assign(obj.headers, {
            'User-Agent': 'coinbase-node-client',
            'Accept': 'application/json',
            'Content-Type': 'application/json',
        }, additional);
        return obj as unknown as RequestOptions // typecast
    };

    public makeRelativeURI(parts: (string | number)[]): string {
        return '/' + parts.join('/');
    };

    public makeAbsoluteURI(relativeURI: string): string {
        return this.apiURI + relativeURI;
    };

    public makeRequestCallback(callback: request.RequestCallback): request.RequestCallback {
        return function(err, response, data): void {
            if (typeof data === "string") {
                data = JSON.parse(data);
            }
            callback(err, response, data);
        };
    };

    public request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', uriParts: (string | number)[],
        opts: GenericObject, callback?: request.RequestCallback): request.Request {

        if (opts.body && (typeof opts.body !== 'string')) {
            opts.body = JSON.stringify(opts.body);
        }
        _.assign(opts, {
            'method': method.toUpperCase(),
            'uri': this.makeAbsoluteURI(this.makeRelativeURI(uriParts)),
            'json': true,
            'agent': new HttpsAgent() // keepalive
        });
        return request(this.addHeaders(opts, null), this.makeRequestCallback(callback));
    };

    public getProducts(callback: request.RequestCallback): request.Request {
        return this.request('GET', ['products'], null, callback);
    };

    public getProductOrderBook(productID: number, level: number, callback: request.RequestCallback): request.Request {
        const opts: GenericObject = { 'qs': { 'level': level } };
        return this.request('GET', ['products', productID, 'book'], opts, callback);
    };

    public getProductTicker(productID, callback: request.RequestCallback): request.Request {
        return this.request('GET', ['products', productID, 'ticker'], null, callback);
    };

    public getProductTrades(productID, callback: request.RequestCallback): request.Request {
        return this.request('GET', ['products', productID, 'trades'], null, callback);
    };

    public getProductHistoricRates(productID, callback: request.RequestCallback): request.Request {
        return this.request('GET', ['products', productID, 'candles'], null, callback);
    };

    public getProduct24HrStats(productID, callback: request.RequestCallback): request.Request {
        return this.request('GET', ['products', productID, 'stats'], null, callback);
    };

    public getCurrencies(callback: request.RequestCallback): request.Request {
        return this.request('GET', ['currencies'], null, callback);
    };

    public getTime(callback: request.RequestCallback): request.Request {
        return this.request('GET', ['time'], null, callback);
    };
}

export class AuthenticatedClient extends PublicClient {
    public constructor(private key: string, private b64secret: string, private passphrase: string, apiURI: string) {
        super(apiURI);
    }

    public request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', uriParts: (string | number)[],
        opts: GenericObject, callback?: request.RequestCallback): request.Request {
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

        return request(this.addHeaders(opts, {
            'CB-ACCESS-KEY': this.key,
            'CB-ACCESS-SIGN': signature,
            'CB-ACCESS-TIMESTAMP': timestamp,
            'CB-ACCESS-PASSPHRASE': this.passphrase,
        }), this.makeRequestCallback(callback));
    };

    public getAccounts(callback: request.RequestCallback): request.Request {
        return this.request('GET', ['accounts'], null, callback);
    };

    public getAccount(accountID, callback: request.RequestCallback): request.Request {
        return this.request('GET', ['accounts', accountID], null, callback);
    };

    public getAccountHistory(accountID, callback: request.RequestCallback): request.Request {
        return this.request('GET', ['accounts', accountID, 'ledger'], null, callback);
    };

    public getAccountHolds(accountID, callback: request.RequestCallback): request.Request {
        return this.request('GET', ['accounts', accountID, 'holds'], null, callback);
    };

    public _placeOrder(params: { size; side; product_id } | string, callback: request.RequestCallback): request.Request {
        return this.request('POST', ['orders'], { 'body': params }, callback);
    };

    public buy(params, callback: request.RequestCallback): request.Request {
        params.side = 'buy';
        return this._placeOrder(params, callback);
    };

    public sell(params, callback: request.RequestCallback): request.Request {
        params.side = 'sell';
        return this._placeOrder(params, callback);
    };

    public cancelOrder(orderID, callback: request.RequestCallback): request.Request {
        return this.request('DELETE', ['orders', orderID], null, callback);
    };
    
    public cancelAllOrders(callback: request.RequestCallback): request.Request {
        return this.request('DELETE', ['orders'], null, callback);
    };

    public getOrders(callback: request.RequestCallback): request.Request {
        return this.request('GET', ['orders'], null, callback);
    };

    public getOrder(orderID, callback: request.RequestCallback): request.Request {
        return this.request('GET', ['orders', orderID], null, callback);
    };

    public getFills(callback: request.RequestCallback): request.Request {
        return this.request('GET', ['fills'], null, callback);
    };

    public deposit(params, callback: request.RequestCallback): request.Request {
        params.type = 'deposit';
        return this._transferFunds(params, callback);
    };

    public withdraw(params, callback: request.RequestCallback): request.Request {
        params.type = 'withdraw';
        return this._transferFunds(params, callback);
    };

    public _transferFunds(params: { type; amount; coinbase_account_id } | string, callback: request.RequestCallback): request.Request {
        return this.request('POST', ['transfers'], { 'body': params }, callback);
    };

};

export class OrderBook extends EventEmitter {
    public state: coinbase.STATES;
    public book: coinbase.CoinbaseBookStorage;
    private queue: number[];
    private socket: WebSocket;
    private failCount: number = 0;
    public constructor(public productID: string, public websocketURI: string,
        public restURI: string, public timeProvider: Utils.ITimeProvider) {
        super();
        this.connect();
    }

    public clearBook(): void {
        this.queue = [];
        this.book = {
            'sequence': null,
            'bids': {},
            'asks': {},
        };
    };

    public connect(): void {
        coinbaseLog.info("Starting connect");
        if (this.socket) {
            this.socket.close();
        }
        this.clearBook();
        this.socket = new WebSocket(this.websocketURI);
        this.socket.on('message', this.onMessage.bind(this));
        this.socket.on('open', this.onOpen.bind(this));
        this.socket.on('close', this.onClose.bind(this));
    };

    public disconnect(): void {
        if (!this.socket) {
            throw new Error("Could not disconnect (not connected)");
        }
        this.socket.close();
        this.onClose();
    };

    public changeState(state: coinbase.STATES): void {
        const oldState = this.state;
        this.state = state;

        if (this.failCount > 3)
            throw new Error("Tried to reconnect 4 times. Giving up.");

        if (state === coinbase.STATES.error || state === coinbase.STATES.closed) {
            this.failCount += 1;
            this.socket.close();
            setTimeout(() => this.connect(), 5000); // eslint-disable-line @typescript-eslint/explicit-function-return-type
        }
        else if (state === coinbase.STATES.processing) {
            this.failCount = 0;
        }

        var sc = { 'old': oldState, 'new': state };
        coinbaseLog.info("statechange: ", sc);
        this.emit('statechange', sc);
    };

    public onOpen(): void {
        this.changeState(coinbase.STATES.open);
        this.sync();
    };

    public onClose(): void {
        this.changeState(coinbase.STATES.closed);
    };

    public onMessage(datastr: string): void {
        var t = this.timeProvider.utcNow();
        var data = JSON.parse(datastr);
        if (this.state !== coinbase.STATES.processing) {
            this.queue.push(data);
        } else {
            this.processMessage(data, t);
        }
    };

    public sync(): void {
        this.changeState(coinbase.STATES.syncing);
        var subscribeMessage = {
            'type': 'subscribe',
            'product_id': this.productID,
        };
        this.socket.send(JSON.stringify(subscribeMessage));
        this.loadSnapshot();
    };

    public loadSnapshot(): void {

        var load = function(data): void {
            var i, bid, ask;
            var convertSnapshotArray = (array): coinbase.CoinbaseEntry => {
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
            this.changeState(coinbase.STATES.processing);
            _.forEach(this.queue, this.processMessage.bind(this));
            this.queue = [];
        };

        request({
            'url': this.restURI + '/products/' + this.productID + '/book?level=3',
            'headers': { 'User-Agent': 'coinbase-node-client' },
        }, function(err, response, body): void {
            if (err) {
                this.changeState(coinbase.STATES.error);
                coinbaseLog.error(err, "error: Failed to load snapshot");
            }
            else if (response.statusCode !== 200) {
                this.changeState(coinbase.STATES.error);
                coinbaseLog.error("Failed to load snapshot", response.statusCode);
            }
            else {
                load(JSON.parse(body));
            }
        });
    };

    public processMessage(message, t: Date): void {
        if (message.sequence <= this.book.sequence) {
            this.emit('ignored', message);
            return;
        }
        if (message.sequence != this.book.sequence + 1) {
            this.changeState(coinbase.STATES.error);
            coinbaseLog.warn("Received message out of order, expected", this.book.sequence, "but got", message.sequence);
        }
        this.book.sequence = message.sequence;

        this.emit(message.type, new Models.Timestamped(message, t));
    };
};
