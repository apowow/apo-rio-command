# Apo Raider.IO Twitch command API

Endpoint:

`GET /api/rio?name=Apodruid&realm=zuljin&region=eu`

`region` accepts `eu` or `us`. The StreamElements command can default to EU if desired.

Example StreamElements command:

`$(customapi https://YOUR-VERCEL-DOMAIN.vercel.app/api/rio?name=$(queryescape $(1))&realm=$(queryescape $(2))&region=$(queryescape $(3)))`

Recommended usage:

`!rio Apodruid zuljin eu`

For realms with spaces, use the Raider.IO realm slug, for example `tarren-mill` or `area-52`.
