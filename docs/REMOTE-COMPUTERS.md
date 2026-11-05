# Dot computers on your own server

FullDots can run its Dots' computers on a Linux server you own (a VPS) while FullDots itself keeps running where it is, for example on your PC. The supervisor and every computer run on the server. Nothing on the server is reachable except ssh: FullDots reaches the supervisor, each computer, the live screen, take-over, replay pictures and the coding bridge through one ssh connection that it opens, watches and closes itself.

This is not the same as [running all of FullDots on a VPS](DEPLOY-VPS.md). There, the app, its database and the computers all move to the server and you open FullDots in a browser over HTTPS. Here, only the computers move; the app, its database and your keys stay on your machine.

## How it works

- You type an **ssh alias** in Settings → Computers: the name of a `Host` in your own `~/.ssh/config`. FullDots stores that name and nothing else about the server. It never asks for, stores or copies an ssh key, password or passphrase; ssh and your ssh-agent keep those.
- For each server in use, FullDots starts **one ssh process**. It carries a dynamic forward bound to `127.0.0.1` on your machine and a small read-only helper on the server's shell that reports Docker, image and container facts. The supervisor and each running computer get their own port on your machine's loopback, and each port leads to exactly one fixed address on the server's loopback, so a port belongs to one Dot's computer and nothing else. No forward is added while ssh runs, so a computer starting never restarts the tunnel, and it works the same with Windows OpenSSH, which has no connection sharing.
- On the server, the supervisor listens on `127.0.0.1:4312` and every computer publishes its port on `127.0.0.1` only. FullDots generates the supervisor token and a computer token for each server, stores them encrypted with the same key as model and connector secrets, and sends them to the server only on ssh's standard input. Your `COMPUTER_TOKEN` and `COMPUTER_SUPERVISOR_TOKEN` stay as they are and are used only for computers on this machine.
- Every ssh call is an argument list (never a shell on your machine), the alias always comes after `--`, and `BatchMode=yes` and `StrictHostKeyChecking=yes` are always on: ssh never prompts and never accepts a host key it has not seen. FullDots adds `ConnectTimeout=10`, `ServerAliveInterval=15` and `ServerAliveCountMax=3` only where your alias leaves them unset, so your own values win.

## Prerequisites

- A Linux server (x86_64 tested) with **Docker Engine** running.
- An ssh user on it that is in the **docker group**, so `docker info` works without `sudo`. Be clear about what that means: membership in the docker group is **root-equivalent** on that server. Anyone who can talk to its Docker can mount the whole disk into a container. Use a **dedicated server** for Dot computers, not one that also holds things you would not hand to an agent.
- `ssh` on this machine (OpenSSH on Linux and macOS; Windows 10 and 11 include OpenSSH; Git Bash's ssh works too).
- FullDots running on your own machine from a checkout (so it can send the Dockerfiles to the server). The set-up buttons are hidden when FullDots runs in a container or is bound to the network; you can still use a server you set up by hand.

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

## 4. Set it up from FullDots

1. Open **Settings → Computers**, choose **Your server (SSH)**, type the alias and press **Save**.
2. Under **Set up my-vps**, run the steps in order. Each step first shows the exact commands; nothing runs on the server until you press **Allow and run**, and the server side refuses commands that differ from what you saw.
   - **Check the alias** runs `true` over ssh.
   - **Check Docker on the server** asks Docker for its version.
   - **Build the images** builds the supervisor, browser and desktop images on the server from the same pinned Dockerfiles and OpenBot revision this machine uses. The `deployment/computers` folder of your checkout goes to the server on standard input as the build context; nothing is pulled from an unpinned tag. The first build downloads about a gigabyte and takes several minutes. It keeps running while you use FullDots, and the card shows its last line.
   - **Start the supervisor** replaces the supervisor container (Dot computers and their files stay) and starts it with `-p 127.0.0.1:4312:4300`, all capabilities dropped and `no-new-privileges`. Its two tokens are sent on standard input and never appear in the command or its output.
3. Press **Check the server**. Then turn a Dot's computer on from its Computer panel as usual.

A Dot can also use its own server: in the Computer panel's settings, type an alias under **Server (ssh alias)**. Blank means the default from Settings → Computers.

To set the server up by hand instead, run the same commands the steps show, from a FullDots checkout.

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

- any port is published on an address other than `127.0.0.1` (or `::1`), or it shares the server's network;
- its image is not the expected tag for its kind (`opendots-computer:b6932d3-acp5` or `opendots-computer-desktop:b6932d3-desk1`);
- it does not drop all capabilities, allows new privileges, runs privileged, or has no memory or process limit;
- it was not created by this deployment's supervisor for this Dot.

The container's environment is never read, because it holds the computer's credential.

## Lifecycle

- The tunnel starts the first time a Dot needs its server, restarts on its own with a growing delay (1 s up to 30 s) when ssh drops, and stops when FullDots shuts down or no Dot and no default uses that server any more. FullDots only ever stops ssh processes it started.
- An unknown host key, a refused key or an unknown alias does not retry on its own: fix it, and the next use tries again.
- Stop keeps a computer's files and browser profile in their volumes on the server.
- **A Dot cannot move to another server while its computer still exists on the old one.** Remove it there first. If the old server cannot be reached, the move goes ahead and FullDots shows the exact command that removes the leftover container once that server is back. FullDots never removes a computer on your server on its own.
- Changing the default server follows the same rule for every Dot that uses the default.

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

If the tunnel fails to start because your alias forwards ports of its own (`LocalForward`, `DynamicForward`), use a second alias without them for FullDots.
