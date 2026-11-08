#!/usr/bin/env python3
"""樣本：以 CU2010 和合本修訂版（上帝版）Bible.com vid=139 RCUV 重抓單卷，
輸出到 books_rcuv / books_csv_rcuv，唔覆蓋原有 414 混版檔案。
用法: python3 build_sample_rcuv.py <CODE> "<書名>" <章數>
"""
import urllib.request, re, time, json, csv, io, sys, os
from bs4 import BeautifulSoup

VID = 139
SLUG = 'RCUV'
JSON_DIR = 'books_rcuv'
CSV_DIR = 'books_csv_rcuv'

def num_to_chinese(n):
    digits = '零一二三四五六七八九'
    if n <= 10:
        return '第' + (digits[n] if n < 10 else '十') + '章'
    if n < 20:
        return '第十' + (digits[n%10] if n%10 else '') + '章'
    if n < 100:
        tens = n // 10
        ones = n % 10
        s = '第' + digits[tens] + '十'
        if ones: s += digits[ones]
        return s + '章'
    hundreds = n // 100
    rest = n % 100
    s = '第' + digits[hundreds] + '百'
    if rest == 0:
        return s + '章'
    if rest < 10:
        s += '零' + digits[rest]
    elif rest < 20:
        s += '一十' + (digits[rest%10] if rest%10 else '')
    else:
        tens = rest // 10
        ones = rest % 10
        s += digits[tens] + '十'
        if ones: s += digits[ones]
    return s + '章'

def _compress_spaces(s):
    # 人名高亮 span 之間會插空格，壓縮中文字符之間嘅多餘空白
    prev = None
    while prev != s:
        prev = s
        s = re.sub(r'(?<=[\u4e00-\u9fff」』）])\s+(?=[\u4e00-\u9fff「『（])', '', s)
    return re.sub(r'\s+', '', s)

def fetch_chapter(book_code, ch, retries=3):
    url = f'https://www.bible.com/bible/{VID}/{book_code}.{ch}.{SLUG}'
    html = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent':'Mozilla/5.0'})
            html = urllib.request.urlopen(req, timeout=30).read().decode('utf-8')
            break
        except Exception:
            if attempt == retries-1: raise
            time.sleep(3)
    soup = BeautifulSoup(html, 'html.parser')
    content = soup.find('div', {'data-testid': 'chapter-content'})
    if not content: return {}
    # 剔除 footnote note blocks
    for note in content.find_all('span', class_='cat7xG_note'):
        note.extract()
    verses = {}
    current = None
    for block in content.find_all('span', class_='cat7xG_verse'):
        t = block.get_text(separator='', strip=True)
        t = _compress_spaces(t)
        if not t:
            continue
        m = re.match(r'^(\d+)(.*)$', t)
        if m:
            current = m.group(1)
            verses[current] = m.group(2).strip()
        elif current is not None:
            verses[current] += t
    # 清殘留 footnote 標記
    for k in verses:
        verses[k] = re.sub(r'#.*$', '', verses[k]).strip()
    return {k: v for k, v in verses.items() if v}

def build_book(book_code, book_title, total_ch):
    rows = []
    page = 1
    for ch in range(1, total_ch+1):
        vs = fetch_chapter(book_code, ch)
        ch_name = num_to_chinese(ch)
        for vnum in sorted(vs.keys(), key=int):
            rows.append({'topic': vnum, 'content': vs[vnum], 'chapter': ch_name, 'page': str(page)})
            page += 1
        time.sleep(0.4)
    for r in rows:
        r['content'] = re.sub(r'或譯：[^。，；：]*', '', r['content'])
        r['content'] = r['content'].replace('#', '').strip()
    return {'book_title': book_title, 'author': '香港聖經公會（和合本2010修訂版·上帝版）',
            'bookmark': '1', 'source': f'Bible.com vid={VID} RCUV 和合本修訂版 上帝版',
            'rows': rows}

def save_book(b):
    title = b['book_title']
    os.makedirs(JSON_DIR, exist_ok=True)
    os.makedirs(CSV_DIR, exist_ok=True)
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

if __name__ == '__main__':
    book_code = sys.argv[1]
    book_title = sys.argv[2]
    total_ch = int(sys.argv[3])
    print(f'>>> building {book_title} ({total_ch} chapters) [RCUV vid={VID}]')
    b = build_book(book_code, book_title, total_ch)
    save_book(b)
    print(f'<<< done: {len(b["rows"])} rows')
