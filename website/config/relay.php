<?php
/**
 * Fallback for relay config when relay.json is not served (e.g. some cPanel blocks .json).
 * Reads relay.json and outputs it with correct headers.
 */
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
$path = __DIR__ . '/relay.json';
if (is_file($path)) {
    readfile($path);
} else {
    http_response_code(404);
    echo '{"relays":["wss://relay.primal.net","wss://relay.damus.io","wss://nos.lol","wss://relay.nostr.band"]}';
}
