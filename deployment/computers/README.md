# OpenBot computer services

FullDots builds the computer service and supervisor from CopilotKit/OpenBot revision `b6932d31a8d6e7896c15139dfc27a6c6911deb27` (MIT). Their source is downloaded by BuildKit from the pinned Git context; it is not resolved from a moving branch or a `latest` image.

The computer image adds a small ACP bridge on the existing API port through a fail-closed patch of the pinned server. It preserves the existing HTTP and screen handlers. The bridge requires the existing per-Dot credential and matching bot ID in headers, starts one coding worker at a time, and kills its process group when its connection closes. Adapter packages are installed from the reviewed lockfile on first use under `/profiles/.coding`, outside the workspace Files root; they are not baked into the image. The image supplies a root-owned managed permission policy, and both the adapter settings manager and SDK session use managed-only settings. The child receives a limited environment without computer or supervisor credentials. See [`acp-bridge/`](acp-bridge/) for settings verification and the [coding-agent guide](../../docs/COMPUTERS.md#coding-agents).

The local computer Dockerfile preserves that revision's Node, Bun and Playwright pins and reads its application source and lockfile from the pinned Git build context. This works with `COMPOSE_BAKE=false` as well as Bake; it does not depend on a separately built base service. Review those runtime pins together with the source revision when upgrading.

The supervisor keeps its narrow ensure/stop/reset/list implementation and resource ownership checks. Its image omits the unused SPIRE CLI, and applies fail-closed patches at build time. The first is to child environment construction: each computer receives `HMAC-SHA256(COMPUTER_TOKEN, "opendots-computer:" + dotId)` instead of the master token. The application uses the same derivation. No supervisor token, model key, or master computer token is forwarded to a computer.

The second sets a CPU limit (`HostConfig.NanoCpus`) on every computer from `COMPUTER_CPUS`, next to the memory and process limits the supervisor already sets. It touches `docker.ts` and `index.ts`, adds `computer-cpus.ts`, which checks the value the way upstream checks `COMPUTER_MEMORY_BYTES`, and refuses to build if any upstream line it replaces has changed.

If the pinned upstream line changes, the patch refuses to build. Upgrades require reviewing the API contracts, ownership/volume behavior, and this patch together. On the next ensure request after a master-token change, the pinned supervisor replaces owned containers with the new credential while retaining their volumes. Do not delete profile or workspace volumes during normal updates.

See [computer setup](../../docs/COMPUTERS.md). OpenBot's MIT license is included in [LICENSE.openbot](LICENSE.openbot).

## Desktop image

`computer-desktop.Dockerfile` extends the local `opendots-computer:b6932d3-acp5` image with XFCE, xdotool, xclip and FFmpeg. Compose supplies the browser build as an additional build context. For a direct build, build the browser image first, then pass the same pinned `openbot` context when building the desktop Dockerfile. The default desktop tag is `opendots-computer-desktop:b6932d3-desk1`.

The desktop keeps a trusted API gateway and the unchanged coding bridge as root. The GUI and an internal browser API run as UID 1001 on a Unix socket with a non-secret internal credential. The real per-Dot credential never enters the GUI environment. The bridge uses a second Unix socket under the private coding directory. Startup validates its managed policies before the GUI starts. No extra TCP listener is introduced.

The fail-closed desktop patches retain the pinned server's sessions, control barrier, browser actions and stream protocol. One FFmpeg process supplies bounded JPEG frames and fresh captures. The gateway increments a control revision before each control request; model capture checks it before and after capture and before sending the image. Native input uses fixed executable arguments and clipboard stdin, not a shell or text in command arguments.

The supervisor chooses the image and 2/4 GiB default by kind, retains explicit memory and CPU limits, and starts the GUI through Docker exec as UID 1001 with all capabilities still dropped. Its owned-desktop health sweep restores the worker after Docker restarts. Stale GUI and API sockets are cleaned before a new session. Volumes survive image or kind replacement. The desktop runtime was tested on amd64; arm64 was not tried. See the [owner guide](../../docs/COMPUTERS.md#full-desktop).
