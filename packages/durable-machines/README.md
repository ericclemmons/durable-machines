# durable-machines

Put an [XState v6](https://stately.ai/docs) machine in a Cloudflare Durable Object. It keeps its state, its timers and its messages to other objects, and you can watch every one of them happen.

**[Docs and live demo](https://durable-machines.ericclemmons.workers.dev/)**

```sh
npm install durable-machines xstate@beta agents effect
```

```ts
import { DurableObject } from "cloudflare:workers";
import type { EventFromLogic } from "xstate";
import { DurableMachine, type Envelope } from "durable-machines";
import { transferMachine } from "./machines/transfer";

export class Transfer extends DurableObject<Env> {
  machine = new DurableMachine(this, transferMachine, {
    input: (id) => ({ transferId: id }),
    actions: {
      toAccount: ({ accountId, event }) => this.machine.deliver("Account", accountId, event),
    },
  });

  send(event: EventFromLogic<typeof transferMachine>, envelope?: Envelope) {
    return this.machine.send(event, envelope);
  }
}
```

```ts
await env.Transfer.getByName("t-42").send({ type: "transfer.cleared" });
```

## What it does

- **State survives.** The machine is saved after every event and restored when the object wakes. It runs on XState's `createDurable`.
- **Timers survive.** `after` and `timeout` wake the object with an alarm, even after eviction.
- **Messages aren't lost or repeated.** `deliver()` writes the message in the same transaction as the state that sent it, and receivers drop repeats.
- **Failures come back.** A message that can't be delivered returns to the sender as `outbox.failed`.
- **You can watch it.** Every object streams its machine, state and messages over a WebSocket.

## Exports

| Import | What |
| --- | --- |
| `durable-machines` | `DurableMachine`, Durable Object call helpers |
| `durable-machines/protocol` | Types for the WebSocket protocol clients use |
| `durable-machines/clock` | A debugger clock that holds messages until you step |
| `durable-machines/graph` | Checks that a machine's diagram shows every transition |

> Early work. The API will change. XState v6 is in beta, and this package tracks it.

MIT
