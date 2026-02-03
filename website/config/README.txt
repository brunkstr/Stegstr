relay.json = only the proxy URL the app connects to (e.g. wss://relay.stegstr.com).
The actual Nostr relays (Primal, nos.lol, etc.) are in relay-proxy/relays.json
on the server where the proxy runs. We are not running a Nostr node—just a
proxy that forwards app traffic to those backends.
