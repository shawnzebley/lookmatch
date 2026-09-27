# Download a photographer's published portfolio images (medium size) into scratch/pub/<key>/ for measuring.
# Images stay in scratch/ (gitignored); only measured numbers go into the repo (engine/style-data.js).
# usage: python3 tools/fetch_published.py cvatik mckinnon xenie borisov
import sys, os, re, urllib.request, hashlib, time

UA = {'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'}

def get(url, timeout=30):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read()

def squarespace(pages):
    urls = []
    for p in pages:
        try: html = get(p).decode('utf8', 'ignore')
        except Exception as e: print('  page failed', p, e, flush=True); continue
        for u in re.findall(r'https?://images\.squarespace-cdn\.com/content/v1/[^"\s?]+\.(?:jpe?g|JPE?G|jpeg)', html):
            if u not in urls: urls.append(u)
    return [u + '?format=750w' for u in urls]

def wfolio(page):
    # each image lists its sizes as [{"src","w","h"},...]; take the one nearest 900 px wide
    import html as H
    urls = []
    for L in re.findall(r'\[\{&quot;src&quot;.*?\}\]', get(page).decode('utf8', 'ignore')):
        items = re.findall(r'"src":"([^"]+)","w":(\d+),"h":(\d+)', H.unescape(L))
        if not items: continue
        u = min(items, key=lambda t: abs(int(t[1]) - 900))[0]
        u = 'https:' + u if u.startswith('//') else u
        if u not in urls: urls.append(u)
    return urls

SOURCES = {
    'cvatik': lambda: squarespace(['https://www.cvatik.com/portrait']),
    'mckinnon': lambda: squarespace([f'https://www.petermckinnon.com/{p}' for p in ('portraits', 'people', 'places', 'lifestyle')]),
    'xenie': lambda: wfolio('https://xenichez.com/en/portfolio'),
    # www. only: the bare lightwitch.com has a broken certificate
    'courtney': lambda: squarespace([f'https://www.lightwitch.com/{p}' for p in ('latest', 'portrait-clients', 'couples', 'fashion', 'musicians', 'commercial-works', 'personal-work', 'humanless', 'strange-fusions', 'archive')]),
    # Ana Dias: Behance hides these projects behind an adult-content sign-in, so the file list was read in a
    # signed-in Chrome (scratch/ana_list.txt, 'projectId:prefix.suffix,...;...') and fetched from the CDN
    'anadias': lambda: [f'https://mir-s3-cdn-cf.behance.net/project_modules/1400/{it.split(".")[0]}{g.split(":")[0]}.{it.split(".")[1]}.jpg'
                        for g in open('scratch/ana_list.txt').read().strip().split(';') for it in g.split(':')[1].split(',')],
    'borisov': lambda: list(dict.fromkeys(re.findall(r'href="https://35photo\.pro/dimm122/photo_\d+/"[^>]*href-mobile="([^"]+)"', get('https://35photo.pro/dimm122').decode('utf8', 'ignore')))),
}

if __name__ == '__main__':
    for key in sys.argv[1:]:
        out = f'scratch/pub/{key}'; os.makedirs(out, exist_ok=True)
        urls = SOURCES[key]()
        print(key, len(urls), 'urls', flush=True)
        ok = 0
        for u in urls:
            fn = os.path.join(out, hashlib.md5(u.encode()).hexdigest()[:12] + '.jpg')
            if os.path.exists(fn): ok += 1; continue
            try:
                data = get(u)
                if len(data) > 5000: open(fn, 'wb').write(data); ok += 1
            except Exception as e:
                print('  fail', u[:90], e, flush=True)
            time.sleep(0.15)
        print(key, ok, 'images', flush=True)
