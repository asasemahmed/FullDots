# An agent you run yourself

A Dot normally thinks with a model you added in Settings → Models. You can instead point it at an agent you run, as long as that agent speaks the AG-UI protocol. LangGraph, CrewAI, Mastra, Pydantic AI, Google ADK and the Claude Agent SDK can all expose an AG-UI endpoint. This page is separate from [Teams](TEAMS.md) because a team hands work between FullDots' own Dots. An agent endpoint replaces how that one Dot thinks.

## Set the endpoint

Open the Dot (its menu in the sidebar, **Edit Dot**) and open **Advanced**.

- **Agent endpoint** is an https address, such as `https://agent.example/ag-ui`.
- **Authorization header** is optional. FullDots sends it only as the `Authorization` header on the request to that address. It is encrypted with the same key as connector sign-ins, and the app never sends it back to the browser. Leave the field blank to keep a header you already saved.

While an endpoint is set, that Dot's chat, mission control, pause and stop still work. The turn is the agent's reply. Pause and stop abort the request.

A remote agent uses its own tools. FullDots' approval gate does not see them. Hand-offs, Spaces and the computer are FullDots tools, and this Dot does not use them while an endpoint is set. Clear the endpoint to use the built-in model and those tools again.

## Which addresses are allowed

A public https address is allowed. These are refused:

- an address that is not https
- an address with a username or password in it (put a key in the authorization field)
- localhost, and private or link-local addresses such as `10.0.0.0/8`, `192.168.0.0/16`, `172.16.0.0/12` and `169.254.0.0/16`

List a host you run yourself in `AGENT_ENDPOINT_ALLOWED_HOSTS` to allow it:

```sh
AGENT_ENDPOINT_ALLOWED_HOSTS=agents.internal,10.0.0.42:9000
```

A host on its own covers any port on that host. A host with a port pins that port. Matching is exact: no wildcards and no suffixes. An entry written as a URL, or containing `*`, stops FullDots from starting and names that entry.

The check runs when you save the Dot, and again on every connection and every redirect. FullDots looks the name up and refuses it if any address is on this machine, a private or link-local network, or a cloud metadata address such as `169.254.169.254`. That includes a name that answers with a public address and then a private one. The connection uses an address from that check. A redirect to a name that points at a private address is refused and not contacted. The authorization header is not sent on to a different host.

A host you listed may point at a private address. A metadata address stays refused even when listed.

The request stops at the same time limit as a built-in turn (`AGENT_TURN_TIMEOUT`, then `AGENT_TURN_GRACE`). A response larger than 4 MB is stopped. That is the same default cap as a computer response.

## What is not included

FullDots does not ship or run those agent servers. You run the agent and give FullDots its address.
