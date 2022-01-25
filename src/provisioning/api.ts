import { Application, default as express, NextFunction, Request, Response, Router, Router as router } from "express";
import { ProvisioningStore } from "./store";
import { Server } from "http";
import { v4 as uuid } from "uuid";
import axios from "axios";
import Logs from "../components/logging";
import ProvisioningRequest from "./request";
import { ApiError } from "./errors";
import { ErrCode } from ".";
import { URL } from "url";
import { MatrixHostResolver } from "../utils/matrix-host-resolver";
import IPCIDR from "ip-cidr";
import { isIP } from "net";
import { promises as dns } from "dns";

// Borrowed from
// https://github.com/matrix-org/synapse/blob/91221b696156e9f1f9deecd425ae58af03ebb5d3/docs/sample_config.yaml#L215
export const DefaultDisallowedIpRanges = [
    '127.0.0.0/8',
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '100.64.0.0/10',
    '192.0.0.0/24',
    '169.254.0.0/16',
    '192.88.99.0/24',
    '198.18.0.0/15',
    '192.0.2.0/24',
    '198.51.100.0/24',
    '203.0.113.0/24',
    '224.0.0.0/4',
    '::1/128',
    'fe80::/10',
    'fc00::/7',
    '2001:db8::/32',
    'ff00::/8',
    'fec0::/10'
]

const log = Logs.get("ProvisioningApi");

interface ExpRequestProvisioner extends Request {
    matrixWidgetToken?: string;
    matrixUserId: string;
}

export interface ExchangeOpenAPIRequestBody {
    openIdToken: string;
    matrixServer: string;
}

export interface ExchangeOpenAPIResponseBody {
    token: string;
    userId: string;
}

export interface ProvisioningApiOpts {
    /**
     * A set of Matrix server names to override the well known response to. Should
     * only be used for testing.
     */
    openIdOverride?: {[serverName: string]: URL},
    /**
     * Disallow these IP ranges from being hit when handling OpenID requests. By default, a number of
     * intenal ranges are blocked.
     * @see DefaultDisallowedIpRanges
     */
    disallowedIpRanges?: string[];
    /**
     * Secret token for provisioning requests
     */
    provisioningToken?: string;
    /**
     * For widget tokens, use this prefix.
     */
    widgetTokenPrefix?: string;
    /**
     * How long should a widget token last for?
     */
    widgetTokenLifetimeMs?: number;
    /**
     * Where are the files stored for the widget frontend. If undefined, do not host a frontend.
     */
    widgetFrontendLocation?: string;
    /**
     * Provide an existing express app to bind to.
     *
     * Note: start() and close() will no-op when this is used.
     */
    expressApp?: Application;
    /**
     * Prefix to use for the API. E.g. `/api` in `/api/v1/session`
     *
     * Default is `/api`.
     */
    apiPrefix?: string;
}


const DEFAULT_WIDGET_TOKEN_PREFIX = "br-sdk-utoken-";
const DEFAULT_WIDGET_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000; // One day

/**
 * The provisioning API serves two classes of clients:
 *  - Integration managers which provide a unique secret token, and a userId
 *  - Widget users which provide a openId token.
 */
export class ProvisioningApi {
    private app: Application;
    private server?: Server;
    protected baseRoute: Router;
    private readonly widgetTokenPrefix: string;
    private readonly widgetTokenLifetimeMs: number;
    private readonly wellknown = new MatrixHostResolver();
    private readonly disallowedIpRanges: IPCIDR[];
    constructor(protected store: ProvisioningStore, private opts: ProvisioningApiOpts) {
        this.app = express();
        this.app.use((req, _res, next) => {
            log.info(`${req.method} ${req.path} ${req.ip || ''} ${req.headers["user-agent"] || ''}`);
            next();
        });

        this.widgetTokenPrefix = opts.widgetTokenPrefix || DEFAULT_WIDGET_TOKEN_PREFIX;
        this.widgetTokenLifetimeMs = opts.widgetTokenLifetimeMs || DEFAULT_WIDGET_TOKEN_LIFETIME_MS;
        this.opts.apiPrefix = opts.apiPrefix || "/provisioning";
        this.disallowedIpRanges = (opts.disallowedIpRanges || DefaultDisallowedIpRanges).map(ip => new IPCIDR(ip));
        this.app.get('/health', this.getHealth.bind(this));
        if (opts.widgetFrontendLocation) {
            this.app.use('/', express.static(opts.widgetFrontendLocation));
        }

        this.app.use((req: express.Request, res: express.Response, next: NextFunction) => {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE');
            next();
        });

        this.baseRoute = router();
        this.baseRoute.use(express.json());
        // Unsecured requests
        this.baseRoute.post(
            `/v1/exchange_openid`,
            (req, res, next) => this.postExchangeOpenId(req, res).catch(ex => next(ex))
        );

        // Secure requests
        // addRoute ensures all successful requests are of type ProvisioningRequest
        this.baseRoute.use((req, res, next) => this.authenticateRequest(req, res, next).catch(ex => next([ex, req])));
        this.addRoute("get", "/v1/session", this.getSession.bind(this));
        this.addRoute("delete", "/v1/session", this.deleteSession.bind(this));
        this.addRoute("delete", "/v1/session/all", this.deleteAllSessions.bind(this));
        this.baseRoute.use(this.onError);

        this.app.use(this.opts.apiPrefix, this.baseRoute);
    }

    public async start(port: number, hostname = "0.0.0.0", backlog = 10): Promise<void> {
        if (this.opts.expressApp) {
            log.warn(`Ignoring call to start(), api configured to use parent express app`);
            return undefined;
        }
        return new Promise<void>((res) => {
            this.server = this.app.listen(port, hostname, backlog, () => res());
            log.info(`Widget API listening on port ${port}`);
        });
    }

    public close(): Promise<void> {
        return new Promise((res, rej) => this.server?.close(e => e ? rej(e) : res()));
    }

    public addRoute(
        method: "get"|"post"|"delete"|"put",
        path: string,
        handler: (req: ProvisioningRequest, res: Response, next?: NextFunction) => void|Promise<void>,
        fnName?: string,): void {
        this.baseRoute[method](path, async (req, res, next) => {
            const expRequest = req as ExpRequestProvisioner;
            const provisioningRequest = new ProvisioningRequest(
                expRequest,
                expRequest.matrixUserId,
                expRequest.matrixWidgetToken ? "widget" : "provisioner",
                expRequest.matrixWidgetToken,
                fnName,
            );
            try {
                await handler(provisioningRequest, res, next);
            }
            catch (ex) {
                // Pass to error handler.
                next([ex, provisioningRequest]);
            }
        });
    }

    private async authenticateRequest(
        req: Request<unknown, unknown, {userId?: string}>, res: Response, next: NextFunction) {
        const authHeader = req.header("Authorization")?.toLowerCase();
        if (!authHeader) {
            throw new ApiError('No Authorization header', ErrCode.BadToken);
        }
        const token = authHeader.startsWith("bearer ") && authHeader.substr("bearer ".length);
        if (!token) {
            return;
        }
        const requestProv = (req as ExpRequestProvisioner);
        if (!this.opts.provisioningToken && req.body.userId) {
            throw new ApiError('Provisioing feature disabled', ErrCode.DisabledFeature);
        }
        if (token === this.opts.provisioningToken) {
            // Integration managers splice in the user_id in the body.
            const userId = req.body?.userId;
            if (!userId) {
                throw new ApiError('No userId in body', ErrCode.BadValue);
            }
            requestProv.matrixUserId = userId;
            requestProv.matrixWidgetToken = undefined;
            next();
            return;
        }
        const session = await this.store.getSessionForToken(token);
        if (session.expiresTs < Date.now()) {
            this.store.deleteSession(token);
            throw new ApiError('Token expired', ErrCode.BadToken);
        }

        requestProv.matrixUserId = session.userId;
        requestProv.matrixWidgetToken = token;
        next();
    }

    private getHealth(req: Request, res: Response) {
        res.send({ok: true});
    }

    private getSession(req: ProvisioningRequest, res: Response) {
        res.send({
            userId: req.userId,
            type: req.requestSource,
        });
    }

    private async deleteSession(req: ProvisioningRequest, res: Response) {
        if (!req.widgetToken) {
            req.log.debug("tried to delete non-existent session");
            throw new ApiError("Session cannot be deleted", ErrCode.UnsupportedOperation);
        }
        try {
            await this.store.deleteSession(req.widgetToken);
        }
        catch (ex) {
            req.log.error("Failed to delete session", ex);
            throw new ApiError("Session could not be deleted", ErrCode.Unknown);
        }
        res.send({ok: true});
    }

    private async deleteAllSessions(req: ProvisioningRequest, res: Response) {
        if (!req.widgetToken) {
            req.log.debug("tried to delete non-existent session");
            throw new ApiError("Session cannot be deleted", ErrCode.UnsupportedOperation);
        }
        try {
            await this.store.deleteAllSessions(req.userId);
        }
        catch (ex) {
            req.log.error("Failed to delete all sessions", ex);
            throw new ApiError("Sessions could not be deleted", ErrCode.Unknown);
        }
        res.send({ok: true});
    }

    private async checkIpBlacklist(url: URL) {
        const host = url.hostname;
        let ip: string;
        if (isIP(host)) {
            ip = host;
        }
        else {
            const record = await dns.lookup(host);
            ip = record.address;
        }

        if (this.disallowedIpRanges.find(d => d.contains(ip))) {
            throw new ApiError('Server is disallowed', ErrCode.BadOpenID);
        }
    }

    private async postExchangeOpenId(
        req: Request<unknown, unknown, ExchangeOpenAPIRequestBody>, res: Response<ExchangeOpenAPIResponseBody>) {
        const server = req.body?.matrixServer;
        const openIdToken = req.body?.openIdToken;
        if (typeof server !== "string") {
            throw new ApiError("Missing/invalid matrixServer in body", ErrCode.BadValue);
        }
        if (typeof openIdToken !== "string") {
            throw new ApiError("Missing/invalid openIdToken in body", ErrCode.BadValue);
        }
        let url: URL;
        let hostHeader: string;
        try {
            const overrideUrl = this.opts.openIdOverride?.[server];
            if (overrideUrl) {
                url = overrideUrl;
                hostHeader = server;
            }
            else {
                const urlRes = await this.wellknown.resolveMatrixServer(server);
                hostHeader = urlRes.hostHeader;
                url = urlRes.url;
                await this.checkIpBlacklist(url);
            }
        }
        catch (ex) {
            log.warn(`Failed to fetch the server URL for ${server}`, ex);
            throw new ApiError("Could not identify server url", ErrCode.BadOpenID);
        }

        // Now do the token exchange
        try {
            const response = await axios.get<{sub: string}>(`${url}/_matrix/federation/v1/openid/userinfo`, {
                params: {
                    access_token: openIdToken,
                },
                headers: {
                    'Host': hostHeader,
                }
            });
            if (!response.data.sub) {
                log.warn(`Server responded with invalid sub information for ${server}`, response.data);
                throw new ApiError("Server did not respond with the correct sub information", ErrCode.BadOpenID);
                return;
            }
            const userId = response.data.sub;
            const token = this.widgetTokenPrefix + uuid().replace(/-/g, "");
            const expiresTs = Date.now() + this.widgetTokenLifetimeMs;
            await this.store.createSession({
                userId,
                token,
                expiresTs,
            });
            res.send({ token, userId });
        }
        catch (ex) {
            log.warn(`Failed to exchnage the token for ${server}`, ex);
            throw new ApiError("Failed to exchange token", ErrCode.BadOpenID);
        }
    }

    // Needed so that _next can be defined in order to preserve signature.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    private onError(err: [unknown, ProvisioningRequest|Request], _req: Request, res: Response, _next: NextFunction) {
        if (!err) {
            return;
        }
        const [error, request] = err;
        if (request instanceof ProvisioningRequest) {
            request.log.error(error);
        }
        else {
            log.error(error);
        }
        if (res.headersSent) {
            return;
        }
        if (err instanceof ApiError) {
            err.apply(res);
        }
        else {
            new ApiError("An internal error occured").apply(res);
        }
    }
}
