"""Measure Wikipedia endpoints on one direct curl_cffi connection pool."""
import json
from io import BytesIO
from time import monotonic, sleep
from urllib.parse import quote, unquote, urlencode

from curl_cffi import Curl, CurlInfo, CurlOpt

TOPICS = [
    ("Rust programming language", "en", "Rust_(programming_language)"),
    ("IPv6", "en", "IPv6"),
    ("Mercury planet", "en", "Mercury_(planet)"),
    ("Солнечное затмение", "ru", "Солнечное_затмение"),
    ("Александр Пушкин", "ru", "Пушкин,_Александр_Сергеевич"),
    ("Mars rover Curiosity", "en", "Curiosity_(rover)"),
    ("Voyager 1 spacecraft", "en", "Voyager_1"),
    ("Transport Layer Security", "en", "Transport_Layer_Security"),
    ("Двоичный поиск", "ru", "Двоичный_поиск"),
    ("PostgreSQL", "en", "PostgreSQL"),
    ("A star search algorithm", "en", "A*_search_algorithm"),
    ("Теорема Пифагора", "ru", "Теорема_Пифагора"),
]
IDENTITIES = {
    "project": "RustXNG-Research-MCP/0.1 (https://github.com/AndrewSnusoed5/rustxng-research-mcp)",
    "rustxng": "rustxng/0.32.0 (+https://github.com/sahenjp/RustXNG)",
}


def endpoint(language, query, mode):
    base = f"https://{language}.wikipedia.org"
    if mode == "summary":
        return base + "/api/rest_v1/page/summary/" + quote(query.replace(" ", "_"), safe="")
    if mode == "action":
        params = dict(action="query", list="search", srsearch=query, srlimit=10, sroffset=0, format="json")
        return base + "/w/api.php?" + urlencode(params)
    return base + "/w/rest.php/v1/search/" + mode + "?" + urlencode(dict(q=query, limit=10))


def titles(payload, mode):
    if mode == "summary":
        title = payload.get("titles", {}).get("canonical")
        return [title] if title else []
    if mode == "action":
        return [row["title"].replace(" ", "_") for row in payload.get("query", {}).get("search", [])]
    return [row["key"] for row in payload.get("pages", [])]


def request(client, query, language, article, mode, identity):
    content, header_bytes = BytesIO(), BytesIO()
    client.reset()
    client.setopt(CurlOpt.URL, endpoint(language, query, mode).encode())
    client.setopt(CurlOpt.PROXY, b"")
    client.setopt(CurlOpt.USERAGENT, IDENTITIES[identity].encode())
    client.setopt(CurlOpt.FOLLOWLOCATION, 1)
    client.setopt(CurlOpt.MAXREDIRS, 5)
    client.setopt(CurlOpt.TIMEOUT_MS, 10000)
    client.setopt(CurlOpt.ACCEPT_ENCODING, b"")
    client.setopt(CurlOpt.WRITEDATA, content)
    client.setopt(CurlOpt.HEADERDATA, header_bytes)
    client.perform()

    def ms(info):
        return round(1000 * client.getinfo(info), 3)

    headers = header_bytes.getvalue().decode("iso-8859-1")
    status = client.getinfo(CurlInfo.RESPONSE_CODE)
    row = dict(query=query, language=language, mode=mode, identity=identity, status=status,
               newConnections=client.getinfo(CurlInfo.NUM_CONNECTS),
               dnsMs=ms(CurlInfo.NAMELOOKUP_TIME), connectMs=ms(CurlInfo.CONNECT_TIME),
               tlsReadyMs=ms(CurlInfo.APPCONNECT_TIME), headersMs=ms(CurlInfo.STARTTRANSFER_TIME),
               totalMs=ms(CurlInfo.TOTAL_TIME), redirects=client.getinfo(CurlInfo.REDIRECT_COUNT),
               retryAfter=any(header.lower().startswith("retry-after:") for header in headers.splitlines()))
    if status == 200:
        payload = json.loads(content.getvalue())
        found = titles(payload, mode)
        row.update(results=len(found), rank=next(
            (i for i, title in enumerate(found[:5], 1) if unquote(title).casefold() == article.casefold()), 0))
        if "error" in payload:
            row["apiError"] = payload["error"].get("code", "unknown")
    return row


def main():
    client = Curl()
    last_started = 0
    modes = [("summary", "project"), ("action", "rustxng"), ("page", "project"),
             ("title", "project"), ("action", "project")]
    try:
        for index, (query, language, article) in enumerate(TOPICS):
            shift = index % len(modes)
            for mode, identity in modes[shift:] + modes[:shift]:
                sleep(max(0, 1.1 - (monotonic() - last_started)))
                last_started = monotonic()
                row = request(client, query, language, article, mode, identity)
                print(json.dumps(row, ensure_ascii=True), flush=True)
                if row["status"] in (429, 503) or row["retryAfter"]:
                    raise SystemExit("Provider asked the probe to slow down. Stopping this run.")
    finally:
        client.close()


if __name__ == "__main__":
    main()
