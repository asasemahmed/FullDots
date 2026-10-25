# OpenBot computer services

FullDots builds the computer service and supervisor from CopilotKit/OpenBot revision `b6932d31a8d6e7896c15139dfc27a6c6911deb27` (MIT). Their source is downloaded by BuildKit from the pinned Git context; it is not resolved from a moving branch or a `latest` image.

The computer image adds a small ACP bridge on the existing API port through a fail-closed patch of the pinned server. It preserves the existing HTTP and screen handlers. The bridge requires the existing per-Dot credential and matching bot ID in headers, starts one coding worker at a time, and kills its process group when its connection closes. Adapter packages are installed from the reviewed lockfile on first use under `/profiles/.coding`, outside the workspace Files root; they are not baked into the image. The image supplies a root-owned managed permission policy, and both the adapter settings manager and SDK session use managed-only settings. The child receives a limited environment without computer or supervisor credentials. See [`acp-bridge/`](acp-bridge/) for settings verification and the [coding-agent guide](../../docs/COMPUTERS.md#coding-agents).

The local computer Dockerfile preserves that revision's Node, Bun and Playwright pins and reads its application source and lockfile from the pinned Git build context. This works with `COMPOSE_BAKE=false` as well as Bake; it does not depend on a separately built base service. Review those runtime pins together with the source revision when upgrading.

The supervisor keeps its narrow ensure/stop/reset/list implementation and resource ownership checks. Its image omits the unused SPIRE CLI, and applies one fail-closed patch to child environment construction: each computer receives `HMAC-SHA256(COMPUTER_TOKEN, "opendots-computer:" + dotId)` instead of the master token. The application uses the same derivation. No supervisor token, model key, or master computer token is forwarded to a computer.

If the pinned upstream line changes, the patch refuses to build. Upgrades require reviewing the API contracts, ownership/volume behavior, and this patch together. On the next ensure request after a master-token change, the pinned supervisor replaces owned containers with the new credential while retaining their volumes. Do not delete profile or workspace volumes during normal updates.

See [computer setup](../../docs/COMPUTERS.md). OpenBot's MIT license is included in [LICENSE.openbot](LICENSE.openbot).
