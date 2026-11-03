import { Container } from "@cloudflare/containers";
import { CONTAINER_PORT, containerEnvironment, fetchLounge } from "./relay.mjs";

export class LoungeContainer extends Container {
    defaultPort = CONTAINER_PORT;
    sleepAfter = "10m";
    enableInternet = true;

    constructor(ctx, env) {
        super(ctx, env);
        this.envVars = containerEnvironment(env);
    }

    fetch(request) {
        return this.containerFetch(request, CONTAINER_PORT);
    }
}

export default { fetch: fetchLounge };
