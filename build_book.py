#!/usr/bin/env python3
"""建檔舊約剩餘書卷——每本完成即時 save JSON+CSV，並 print 完成旗標俾 outer loop commit."""
import urllib.request, re, time, json, csv, io, sys
from bs4 import BeautifulSoup

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
    # 100+
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

def fetch_chapter(book_code, ch, retries=3):
    url = f'https://www.bible.com/bible/414/{book_code}.{ch}.CUNP-%E4%B8%8A%E5%B8%9D'
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent':'Mozilla/5.0'})
            html = urllib.request.urlopen(req, timeout=30).read().decode('utf-8')
            break
        except:
            if attempt == retries-1: raise
            time.sleep(3)
    soup = BeautifulSoup(html, 'html.parser')
    content = soup.find('div', {'data-testid': 'chapter-content'})
    if not content: return {}
    text = content.get_text(separator='\n', strip=True)
    lines = [l.strip() for l in text.split('\n') if l.strip()]
    verses = {}
    i = 1
    while i < len(lines):
        line = lines[i]
        if re.match(r'^\d+$', line):
            vnum = line
            vtext_parts = []
            k = i + 1
            while k < len(lines) and not re.match(r'^\d+$', lines[k]):
                l = lines[k]
                if l.startswith('#') or re.match(r'^[：:].*或譯', l) or l == '#':
                    k += 1; continue
                vtext_parts.append(l)
                k += 1
            vtext = ''.join(vtext_parts)
            vtext = re.sub(r'Currently.*$', '', vtext)
            vtext = vtext.strip()
            if vnum in verses: verses[vnum] += vtext
            else: verses[vnum] = vtext
            i = k
        else:
            i += 1
    return verses

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
    # clean footnotes
    for r in rows:
        r['content'] = re.sub(r'或譯：[^。，；：]*', '', r['content'])
        r['content'] = r['content'].replace('#', '')
    return {'book_title': book_title, 'author': '教會', 'bookmark': '1', 'rows': rows}

def save_book(b):
    title = b['book_title']
    with open(f'books/{title}.json', 'w', encoding='utf-8') as f:
        json.dump(b, f, ensure_ascii=False, indent=2)
    out = io.StringIO()
    out.write(f"book_title,{title},,\r\n")
    out.write(f"author,{b['author']},,\r\n")
    out.write(f"bookmark,{b['bookmark']},,\r\n")
    w = csv.writer(out, lineterminator='\r\n')
    w.writerow(['chapter','page','topic','content'])
    for r in b['rows']:
        w.writerow([r['chapter'], r['page'], r['topic'], r['content']])
    with open(f'books_csv/{title}.csv', 'w', encoding='utf-8-sig', newline='') as f:
        f.write(out.getvalue())

if __name__ == '__main__':
    book_code = sys.argv[1]
    book_title = sys.argv[2]
    total_ch = int(sys.argv[3])
    print(f'>>> building {book_title} ({total_ch} chapters)')
    b = build_book(book_code, book_title, total_ch)
    save_book(b)
    print(f'<<< done: {len(b["rows"])} rows')
