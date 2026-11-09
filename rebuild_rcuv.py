#!/usr/bin/env python3
"""批量以 CU2010 RCUV vid=139（上帝版）重抓 66 卷聖經，直接覆寫 books/ 同 books_csv/。
用法:
  python3 rebuild_rcuv.py            # 全部 66 卷
  python3 rebuild_rcuv.py 出埃及記   # 指定一卷（書名 short）
每卷產出品質檢查；失敗/異常唔覆蓋舊檔，列入 manifest 報告。
"""
import urllib.request, re, time, json, csv, io, sys, os, glob, gzip
from concurrent.futures import ThreadPoolExecutor
from bs4 import BeautifulSoup

VID = 139
SLUG = 'RCUV'
JSON_DIR = 'books'
CSV_DIR = 'books_csv'

CODE = {
'創世紀':'GEN','出埃及記':'EXO','利未記':'LEV','民數記':'NUM','申命記':'DEU',
'約書亞記':'JOS','士師記':'JDG','路得記':'RUT','撒母耳記上':'1SA','撒母耳記下':'2SA',
'列王紀上':'1KI','列王紀下':'2KI','歷代志上':'1CH','歷代志下':'2CH','以斯拉記':'EZR',
'尼希米記':'NEH','以斯帖記':'EST','約伯記':'JOB','詩篇':'PSA','箴言':'PRO','傳道書':'ECC',
'雅歌':'SNG','以賽亞書':'ISA','耶利米書':'JER','耶利米哀歌':'LAM','以西結書':'EZK',
'但以理書':'DAN','何西阿書':'HOS','約珥書':'JOL','阿摩司書':'AMO','俄巴底亞書':'OBA',
'約拿書':'JON','彌迦書':'MIC','那鴻書':'NAM','哈巴谷書':'HAB','西番雅書':'ZEP',
'哈該書':'HAG','撒加利亞書':'ZEC','瑪拉基書':'MAL',
'馬太福音':'MAT','馬可福音':'MRK','路加福音':'LUK','約翰福音':'JHN','使徒行傳':'ACT',
'羅馬書':'ROM','哥林多前書':'1CO','哥林多後書':'2CO','加拉太書':'GAL','以弗所書':'EPH',
'腓立比書':'PHP','歌羅西書':'COL','帖撒羅尼迦前書':'1TH','帖撒羅尼迦後書':'2TH',
'提摩太前書':'1TI','提摩太後書':'2TI','提多書':'TIT','腓利門書':'PHM','希伯來書':'HEB',
'雅各書':'JAS','彼得前書':'1PE','彼得後書':'2PE','約翰一書':'1JN','約翰二書':'2JN',
'約翰三書':'3JN','猶大書':'JUD','啟示錄':'REV'}

def num_to_chinese(n):
    digits = '零一二三四五六七八九'
    if n <= 10:
        return '第' + (digits[n] if n < 10 else '十') + '章'
    if n < 20:
        return '第十' + (digits[n%10] if n%10 else '') + '章'
    if n < 100:
        tens = n // 10; ones = n % 10
        s = '第' + digits[tens] + '十'
        if ones: s += digits[ones]
        return s + '章'
    hundreds = n // 100; rest = n % 100
    s = '第' + digits[hundreds] + '百'
    if rest == 0: return s + '章'
    if rest < 10: s += '零' + digits[rest]
    elif rest < 20: s += '一十' + (digits[rest%10] if rest%10 else '')
    else:
        tens = rest // 10; ones = rest % 10
        s += digits[tens] + '十'
        if ones: s += digits[ones]
    return s + '章'

def _compress_spaces(s):
    prev = None
    while prev != s:
        prev = s
        s = re.sub(r'(?<=[\u4e00-\u9fff」』）])\s+(?=[\u4e00-\u9fff「『（])', '', s)
    return re.sub(r'\s+', '', s)

def fetch_chapter(book_code, ch, retries=4):
    url = f'https://www.bible.com/bible/{VID}/{book_code}.{ch}.{SLUG}'
    html = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent':'Mozilla/5.0','Accept-Encoding':'gzip'})
            resp = urllib.request.urlopen(req, timeout=30)
            data = resp.read()
            if resp.headers.get('Content-Encoding') == 'gzip':
                data = gzip.decompress(data)
            html = data.decode('utf-8')
            break
        except Exception:
            if attempt == retries-1: raise
            time.sleep(3)
    soup = BeautifulSoup(html, 'html.parser')
    content = soup.find('div', {'data-testid': 'chapter-content'})
    if not content: return {}
    for note in content.find_all('span', class_='cat7xG_note'):
        note.extract()
    verses = {}
    current = None
    for block in content.find_all('span', class_='cat7xG_verse'):
        # 優先用 data-usfm 權威節號：PSA.1.1+PSA.1.2 → 跨節合併，歸第一節
        usfm = block.get('data-usfm') or ''
        nums = []
        for p in usfm.split('+'):
            m = re.search(r'\.(\d+)$', p)
            if m: nums.append(int(m.group(1)))
        t = block.get_text(separator='', strip=True)
        t = _compress_spaces(t)
        # 剝離開頭節號 label（含跨節 1-2 / 1–2 形式）
        t = re.sub(r'^\d+\s*[-–—]\s*\d+', '', t)
        t = re.sub(r'^\d+', '', t)
        t = t.strip()
        if not t: continue
        if nums:
            current = str(nums[0]); verses.setdefault(current, '')
            verses[current] += t
        elif current is not None:
            verses[current] += t
    for k in verses:
        verses[k] = re.sub(r'#.*$', '', verses[k]).strip()
    return {k: v for k, v in verses.items() if v}

def build_book(book_code, book_title, total_ch):
    rows = []; page = 1; chap_stats = {}
    ch_nums = list(range(1, total_ch+1))
    def job(ch):
        return ch, fetch_chapter(book_code, ch)
    fetched = {}
    with ThreadPoolExecutor(max_workers=5) as ex:
        for ch, vs in ex.map(job, ch_nums):
            fetched[ch] = vs
    for ch in ch_nums:
        vs = fetched[ch]
        ch_name = num_to_chinese(ch)
        chap_stats[ch] = len(vs)
        for vnum in sorted(vs.keys(), key=int):
            rows.append({'topic': vnum, 'content': vs[vnum], 'chapter': ch_name, 'page': str(page)})
            page += 1
        time.sleep(0.1)
    for r in rows:
        r['content'] = re.sub(r'或譯：[^。，；：]*', '', r['content'])
        r['content'] = r['content'].replace('#', '').strip()
    b = {'book_title': book_title,
         'author': '香港聖經公會（和合本2010修訂版·上帝版）',
         'bookmark': '1',
         'source': f'Bible.com vid={VID} RCUV 和合本修訂版 上帝版',
         'rows': rows}
    return b, chap_stats

def save_book(b):
    title = b['book_title']
    os.makedirs(JSON_DIR, exist_ok=True); os.makedirs(CSV_DIR, exist_ok=True)
    with open(f'{JSON_DIR}/{title}.json', 'w', encoding='utf-8') as f:
        json.dump(b, f, ensure_ascii=False, indent=2)
    out = io.StringIO()
    out.write(f"book_title,{title},,\r\n")
    out.write(f"author,{b['author']},,\r\n")
    out.write(f"bookmark,{b['bookmark']},,\r\n")
    w = csv.writer(out, lineterminator='\r\n')
    w.writerow(['chapter','page','topic','content'])
    for r in b['rows']:
        w.writerow([r['chapter'], r['page'], r['topic'], r['content']])
    with open(f'{CSV_DIR}/{title}.csv', 'w', encoding='utf-8-sig', newline='') as f:
        f.write(out.getvalue())

def quality_check(b, old_rows, chap_stats, total_ch):
    issues = []
    rows = b['rows']
    if len(rows) == 0: issues.append('ZERO_ROWS')
    # empty content
    empty = [r['topic'] for r in rows if not r['content'].strip()]
    if empty: issues.append(f'EMPTY:{empty[:5]}')
    # footnote residue
    res = [r['topic'] for r in rows if '或譯' in r['content'] or '#' in r['content']]
    if res: issues.append(f'NOTE_RESIDUE:{res[:5]}')
    # missing chapters
    zero_ch = [c for c,n in chap_stats.items() if n==0]
    if zero_ch: issues.append(f'ZERO_CHAPTER:{zero_ch[:5]}')
    return issues

def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    books = sorted(glob.glob(f'{JSON_DIR}/聖經*.json'))
    manifest = []
    for x in books:
        old = json.load(open(x))
        title = old['book_title']
        short = title.split(' - ',1)[1] if ' - ' in title else title
        if short == '目錄': continue
        if only and short != only: continue
        if short not in CODE:
            manifest.append((short, 'SKIP_UNMAPPED', 0, len(old['rows']), [])); continue
        code = CODE[short]
        total_ch = len(set(r['chapter'] for r in old['rows']))
        print(f'>>> {short} ({code}, {total_ch} ch, old v={len(old["rows"])})', flush=True)
        try:
            b, chap_stats = build_book(code, title, total_ch)
            issues = quality_check(b, old['rows'], chap_stats, total_ch)
            if issues and 'ZERO_ROWS' in issues:
                manifest.append((short, 'FAILED', len(b['rows']), len(old['rows']), issues))
                print('    !! FAILED, keep old file:', issues, flush=True)
                continue
            save_book(b)
            status = 'OK' if not issues else 'WARN'
            manifest.append((short, status, len(b['rows']), len(old['rows']), issues))
            print(f'    <<< {status}: new v={len(b["rows"])} old v={len(old["rows"])} {issues}', flush=True)
        except Exception as e:
            manifest.append((short, 'ERROR', 0, len(old['rows']), [str(e)[:120]]))
            print('    !! ERROR:', e, flush=True)
    with open('rebuild_manifest.json','w',encoding='utf-8') as f:
        json.dump([{'book':m[0],'status':m[1],'new':m[2],'old':m[3],'issues':m[4]} for m in manifest],
                  f, ensure_ascii=False, indent=2)
    print('\n=== SUMMARY ===')
    for short,status,new,old,issues in manifest:
        print(f'{status:6} {short:12} {old} -> {new} {issues if issues else ""}')

if __name__ == '__main__':
    main()
