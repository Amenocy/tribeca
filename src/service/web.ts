
import Messaging = require("../common/messaging");
import _ = require("lodash");
import express = require("express");
import Persister = require("./persister");
import moment = require("moment");

export class StandaloneHttpPublisher<T> {
    constructor(
        private _wrapped: Messaging.IPublish<T>,
        private route: string,
        private _httpApp: express.Application,
        private _persister: Persister.ILoadAll<T>) {
        
        _httpApp.get("/data/" + route, (req: express.Request, res: express.Response) => {
            var getParameter = <T>(pName: string, cvt: (r: string) => T) => {
                var rawMax: string = req.param(pName, null);
                return (rawMax === null ? null : cvt(rawMax));
            };
            
            var max = getParameter<number>("max", r => parseInt(r));
            var startTime = getParameter<moment.Moment>("start_time", r => moment(r));

            var handler = (d: T[]) => {
                if (max !== null && max <= d.length)
                    d = _.takeRight(d, max);
                res.json(d);
            };

            const selector: Record<string, any> = startTime == null
                ? null
                : {time: { $gte: startTime.toDate() }}

            _persister.loadAll(max, selector).then(handler);
        });
    }

    public publish = this._wrapped.publish;

    public registerSnapshot = (generator: () => T[]) => {
        return this._wrapped.registerSnapshot(generator);
    }
}