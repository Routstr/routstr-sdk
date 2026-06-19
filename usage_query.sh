#!/bin/bash
DB="$(dirname "$0")/routstr.sqlite"
sqlite3 "$DB" ".headers on" ".mode column" "SELECT model_id, base_url, provider, prompt_tokens as input, completion_tokens as output, cache_read_input_tokens as cache_r,  cache_creation_input_tokens as cache_w, input_msats as in_msats, output_msats as out_msats, sats_cost FROM usage_tracking;"
