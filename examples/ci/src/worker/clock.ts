import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { WebSockets } from "agents/websockets";
import { accounts, installations, projects } from "../domain/registry";
import { Clock as ClockCapability, ClockCallables } from "durable-machines/clock";
import type { ClockSettings, ParkRequest, Parked } from "durable-machines/protocol";

/** Every machine-hosting object, by owner address. */
const objectFor = (env: Env, owner: string) => {
  const [cls, name] = owner.split("/") as [string, string];
  if (cls === "Installation") return env.Installation.getByName(name);
  if (cls === "Account") return env.Account.getByName(name);
  if (cls === "Project") return env.Project.getByName(name);
  return undefined;
};

/** The one debugger clock (name "global"): play, pause, next, and speed. */
export class Clock extends DurableObject<Env> {
  readonly clock: ClockCapability = new ClockCapability({
    release: async ({ owner, token }: Parked) => {
      if (owner.startsWith("BuildWorkflow/")) {
        const instance = await this.env.BUILD_WORKFLOW.get(owner.slice("BuildWorkflow/".length));
        await instance.sendEvent({ type: token, payload: {} });
        return true;
      }
      return (await objectFor(this.env, owner)?.release(token)) ?? false;
    },
    configure: async (settings: ClockSettings) => {
      await Promise.all(
        [
          ...Object.keys(installations).map((id) => `Installation/${id}`),
          ...Object.keys(accounts).map((id) => `Account/${id}`),
          ...Object.keys(projects).map((id) => `Project/${id}`),
        ].map((owner) => objectFor(this.env, owner)!.setClock(settings)),
      );
    },
    broadcast: (frame) => {
      for (const connection of this.webSockets.getConnections()) connection.send(frame);
    },
  });
  readonly webSockets: WebSockets = new WebSockets({ state: this.clock, callables: new ClockCallables(this.clock) });
  readonly lifecycle = Lifecycle.install(this).use(this.clock).use(this.webSockets);

  async park(request: ParkRequest) {
    await this.lifecycle.start();
    return this.clock.park(request);
  }

  async state() {
    await this.lifecycle.start();
    return this.clock.get();
  }

  async control(action: "play" | "pause" | "next" | "nextMachine" | "clear", pace?: number) {
    await this.lifecycle.start();
    if (pace !== undefined) await this.clock.setPace(pace);
    if (action === "play") await this.clock.play();
    if (action === "pause") await this.clock.pause();
    if (action === "next") await this.clock.next();
    if (action === "nextMachine") await this.clock.nextMachine();
    if (action === "clear") this.clock.clear();
    return this.clock.get();
  }
}
