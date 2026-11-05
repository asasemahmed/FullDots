# Dot computers on your own server

FullDots can run its Dots' computers on a Linux server you own (a VPS) while FullDots itself keeps running where it is, for example on your PC. The supervisor and every computer run on the server. Nothing on the server is reachable except ssh: FullDots reaches the supervisor, each computer, the live screen, take-over, replay pictures and the coding bridge through one ssh connection that it opens, watches and closes itself.

This is not the same as [running all of FullDots on a VPS](DEPLOY-VPS.md). There, the app, its database and the computers all move to the server and you open FullDots in a browser over HTTPS. Here, only the computers move; the app, its database and your keys stay on your machine.

## How it works

- You type an **ssh alias** in Settings → Computers: the name of a `Host` in your own `~/.ssh/config`. FullDots stores that name and nothing else about the server. It never asks for, stores or copies an ssh key, password or passphrase; ssh and your ssh-agent keep those.
- For each server in use, FullDots starts **one ssh process** and forwards no port with it at all (`ClearAllForwardings=yes`; your server can even forbid forwarding, see [Harden the ssh login](#4-harden-the-ssh-login-recommended)). The ssh session runs a small **relay** on the server: a throwaway container of the pinned supervisor image (`--network host` so it can reach the server's loopback, the Docker socket so it can check, all capabilities dropped, read-only, an unprivileged user, no logs). Every connection travels as frames inside that one session. On your machine, the supervisor and each running computer get their own port on loopback; each port leads to exactly one port on the server's loopback, and before every connection the relay asks the server's Docker that this port is, right now, the API port of that Dot's managed computer (or the supervisor's `127.0.0.1:4312`). Anything else is refused: there is no general proxy to the server's network, its cloud metadata address or the internet. Nothing is added while ssh runs, so a computer starting never restarts the tunnel, and it works the same with Windows OpenSSH, which has no connection sharing.
- On the server, the supervisor listens on `127.0.0.1:4312` and every computer publishes its port on `127.0.0.1` only. FullDots generates the supervisor token and a computer token for each server, stores them encrypted with the same key as model and connector secrets, and sends them to the server only on ssh's standard input. Your `COMPUTER_TOKEN` and `COMPUTER_SUPERVISOR_TOKEN` stay as they are and are used only for computers on this machine.
- Every ssh call is an argument list (never a shell on your machine), the alias always comes after `--`, and these always come first, so your config cannot change them: `BatchMode=yes` and `StrictHostKeyChecking=yes` (ssh never prompts and never accepts a host key it has not seen), `ControlMaster=no` and `ControlPath=none` (no shared connections), `-a -x ForwardAgent=no ForwardX11=no` (no agent or X11 forwarding), `PermitLocalCommand=no` and `ClearAllForwardings=yes`. An alias whose config sets `LocalForward`, `RemoteForward` or `DynamicForward` is refused with a clear message. FullDots adds `ConnectTimeout=10`, `ServerAliveInterval=15` and `ServerAliveCountMax=3` only where your alias leaves them unset, so your own values win.

## Prerequisites

- A Linux server (x86_64 tested) with **Docker Engine** running.
- An ssh user on it that is in the **docker group**, so `docker info` works without `sudo`. Be clear about what that means: membership in the docker group is **root-equivalent** on that server. Anyone who can talk to its Docker can mount the whole disk into a container. Use a **dedicated server** for Dot computers, not one that also holds things you would not hand to an agent.
- `ssh` on this machine (OpenSSH on Linux and macOS; Windows 10 and 11 include OpenSSH; Git Bash's ssh works too).
- FullDots running on your own machine. **Build the images** also needs it to run from a checkout, so it can send the Dockerfiles. The set-up buttons are hidden when FullDots runs in a container or is bound to the network; you can still use a server you set up by hand (see [Set it up by hand](#set-it-up-by-hand)).

## 1. Add the server to your ssh config

```sshconfig
Host my-vps
  HostName 203.0.113.7
  User dots
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes
  ServerAliveInterval 15
  ServerAliveCountMax 3
  ConnectTimeout 10
```

The alias may contain letters, digits, dot, dash and underscore, and must not start with a dash. A passphrase-protected key works when it is loaded in ssh-agent.

On Windows, Windows OpenSSH refuses a private key that other users can read. If `ssh my-vps true` says the key permissions are too open, remove the other users from the key file's permissions.

## 2. Check the host key yourself, once

```sh
ssh my-vps true
```

Compare the fingerprint ssh shows with the one your provider shows, then answer yes. That puts the key in your `known_hosts` on your terms. FullDots never accepts a host key: an alias whose host key is unknown fails until you have done this.

## 3. Firewall the server to ssh only

Nothing FullDots does needs any other inbound port. For example with ufw:

```sh
sudo ufw default deny incoming
sudo ufw allow OpenSSH
sudo ufw enable
```

Limit ssh to your own address where you can.

## 4. Harden the ssh login (recommended)

FullDots needs no port forwarding, no agent, no X11 and no terminal on the server. You can forbid them all for the key FullDots uses, so a stolen copy of that key cannot open a tunnel into the server's network either. In `~/.ssh/authorized_keys` on the server, put `restrict` in front of the key:

```text
restrict ssh-ed25519 AAAA... you@your-pc
```

Or, for the whole ssh user, in `/etc/ssh/sshd_config` (then `sudo systemctl reload ssh`):

```sshconfig
Match User dots
  AllowTcpForwarding no
  AllowStreamLocalForwarding no
  PermitTunnel no
  X11Forwarding no
  PermitOpen none
```

If you need forwarding for something else, limit it instead with `PermitOpen 127.0.0.1:*` (or `permitopen="127.0.0.1:*"` on the key). FullDots was tested with `restrict` and `AllowTcpForwarding no`.

## 5. Set it up from FullDots

1. Open **Settings → Computers**, choose **Your server (SSH)**, type the alias and press **Save**.
2. Under **Set up my-vps**, run the steps in order. Each step first shows the exact commands; nothing runs on the server until you press **Allow and run**, and the server side refuses commands that differ from what you saw.
   - **Check the alias** runs `true` over ssh.
   - **Check Docker on the server** asks Docker for its version.
   - **Build the images** builds the supervisor, browser and desktop images on the server from the same pinned Dockerfiles and OpenBot revision this machine uses. The `deployment/computers` folder of your checkout goes to the server on standard input as the build context; nothing is pulled from an unpinned tag. The first build downloads about a gigabyte and takes several minutes. It keeps running while you use FullDots, and the card shows its last line.
   - **Start the supervisor** first reads which FullDots server record started the supervisor that is there (a `fulldots.server-id` label), and stops if another alias of yours already set up this server. Then it replaces the supervisor container (Dot computers and their files stay) and starts it with `-p 127.0.0.1:4312:4300`, all capabilities dropped, `no-new-privileges`, a memory and process limit and that label. Its two tokens are sent on standard input and never appear in the command or its output. If the stored tokens no longer decrypt (the connector key changed), this step makes new ones and says so.
3. Press **Check the server**. Then turn a Dot's computer on from its Computer panel as usual.

A Dot can also use its own server: in the Computer panel's settings, type an alias under **Server (ssh alias)**. Blank means the default from Settings → Computers.

### Set it up by hand

Use this when FullDots runs in a container or without a checkout, or when you prefer to type the commands.

1. Build the three images on the server from a FullDots checkout: run the commands **Build the images** shows, in a terminal on a machine with that checkout (they send `deployment/computers` on standard input). Or copy the checkout to the server and run the same `docker build` commands there with `.` instead of `-`.
2. Get the tokens. In Settings → Computers, under **Supervisor tokens**, choose **Show the supervisor settings once**. FullDots shows the env file and the exact `docker run` command once, with a warning; to see them again you must **Make new tokens**, which stops the old ones. Save the file as `supervisor.env` on a machine only you use, run the command (it reads the file on standard input), then delete the file. If you already run a supervisor with tokens of your own, choose **Use my own tokens** and paste them instead (32 to 256 letters, digits, dash or underscore).
3. Press **Check the server**.

A supervisor started by hand must carry the `fulldots.server-id` label from that command, or **Check the server** says it was not started for this alias.

## What the status messages mean

The Computer panel and **Check the server** report the first check that fails, in this order. Each message names the step that fixes it.

| Status                  | What it means                                                                                   | What to do                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Alias not set           | "Your server" is chosen but no alias is saved.                                                  | Type the alias in Settings → Computers.                                                        |
| ssh refused or host key | ssh could not log in: unknown or changed host key, key refused, alias not found, no answer.     | Run `ssh my-vps true` in a terminal and fix what it says.                                      |
| Docker not reachable    | Docker is missing or stopped, or the ssh user is not in the docker group.                       | `sudo usermod -aG docker $USER`, log in again; or start Docker.                                |
| Images missing          | One of the three image tags is not on the server.                                               | Run **Build the images**.                                                                      |
| Supervisor not running  | The supervisor container is missing or stopped, or it is not the one FullDots starts.           | Run **Start the supervisor**; `ssh my-vps docker logs fulldots-computer-supervisor` shows why. |
| Computer stopped        | This Dot's computer exists but is not running, or does not exist yet.                           | Press **Start**.                                                                               |
| Computer unsafe         | The container publishes a port on a public address, runs another image, or lacks the hardening. | FullDots refuses it and never repairs it. Remove it by hand (below) and start it again.        |
| Not ready               | The browser or desktop inside has not answered yet.                                             | Wait a moment; if it stays, Stop and Start the computer.                                       |

A turn that needs the computer fails with the same clear message when the server cannot be reached. It never falls back to this machine's Docker.

## Safety checks before every use

Each time FullDots uses a computer on the server, not only when it is created, it checks the container through the ssh helper and refuses it when:

- any port is published on an address other than `127.0.0.1` (or `::1`), the port the supervisor names is not one the container itself publishes on loopback for its API, or it uses a network other than the default bridge (host networking included);
- its image is not the expected tag for its kind (`opendots-computer:b6932d3-acp5` or `opendots-computer-desktop:b6932d3-desk1`);
- it does not drop all capabilities, adds any, allows new privileges, turns off a security profile (`seccomp=unconfined`, `apparmor=unconfined`, `label=disable`), runs privileged, has host devices, shares the process, IPC or user namespace, uses a runtime other than runc, or has no memory or process limit;
- it has any mount other than its own two volumes (`/profiles` and `/workspace`): a bind mount or the Docker socket is refused;
- it was not created by this deployment's supervisor for this Dot.

The supervisor gets the same checks, with one difference: it must have exactly one bind mount, the Docker socket, and be published only on `127.0.0.1:4312`. A supervisor on the host network is refused.

The container's environment is never read, because it holds the computer's credential.

## Lifecycle

- The tunnel starts the first time a Dot needs its server, restarts on its own with a growing delay (1 s up to 30 s) when ssh drops, and stops when FullDots shuts down or no Dot and no default uses that server any more. FullDots only ever stops ssh processes it started.
- A problem that retrying cannot fix (an unknown or changed host key, a refused key, an unknown alias, ssh not found, an alias that forwards ports) does not start ssh again on every poll or connection. It is tried again when you press **Check the server**, or on the next use after 30 seconds.
- A tunnel that **Check the server** or a set-up step opened is stopped again when it is done, if no Dot and no default uses that server.
- Stop keeps a computer's files and browser profile in their volumes on the server.
- **A Dot cannot move to another server while its computer still exists on the old one.** Remove it there first. If the old server cannot be reached, the move goes ahead and FullDots shows the exact command that removes the leftover container once that server is back. FullDots never removes a computer on your server on its own.
- Changing the default server follows the same rule for every Dot that uses the default.
- **One alias per server.** FullDots makes tokens per alias. Two aliases for the same server would each start the supervisor with their own tokens and lock the other out, so FullDots writes a server id on the supervisor, refuses to start it for a second alias, and **Check the server** names the alias that owns it.
- **Make new tokens** (Settings → Computers → Supervisor tokens) replaces both tokens. Run **Start the supervisor** again afterwards; each computer is replaced with the new credential on its next start and keeps its files.

## Remove a computer by hand

```sh
ssh my-vps docker rm -f opendots-computer-<dot id>
```

Its files and browser profile stay in the `opendots-workspace-<dot id>` and `opendots-profile-<dot id>` volumes, and the next Start uses them again. To remove everything FullDots put on the server, also run `docker rm -f fulldots-computer-supervisor` and remove the volumes and the three images.

## Settings

| Variable               | Default                | What it does                                                                           |
| ---------------------- | ---------------------- | -------------------------------------------------------------------------------------- |
| `COMPUTER_SSH_COMMAND` | `ssh` from your `PATH` | The ssh program to run.                                                                |
| `COMPUTER_SSH_CONFIG`  | ssh's usual files      | An ssh config file passed with `-F` instead of `~/.ssh/config`, for example for tests. |

## Troubleshooting

Work in the order the app checks:

1. **The alias works by hand:** `ssh my-vps true` returns without a prompt. A password prompt means the key or agent is not set up; a host key question means step 2 has not been done.
2. **Docker answers:** `ssh my-vps docker info`. "permission denied ... docker.sock" means the user is not in the docker group; log out and in again after adding it.
3. **The images are there:** `ssh my-vps docker images` lists `opendots-supervisor:b6932d3-desktop1`, `opendots-computer:b6932d3-acp5` and `opendots-computer-desktop:b6932d3-desk1`.
4. **The supervisor runs on loopback:** `ssh my-vps docker ps` shows `fulldots-computer-supervisor` with `127.0.0.1:4312->4300/tcp`.
5. **Nothing public is listening:** `ssh my-vps ss -ltn` shows only ssh on a public address; the supervisor and computers are on `127.0.0.1`.
6. **The computer:** `ssh my-vps docker ps -a --filter label=openbot.supervisor=true` shows each Dot's computer with a `127.0.0.1:` port.

If FullDots says your alias forwards ports (`LocalForward`, `RemoteForward`, `DynamicForward`), add a second `Host` without them for FullDots.

If **Check the server** says ssh could not start, install OpenSSH or set `COMPUTER_SSH_COMMAND` to the ssh program.
