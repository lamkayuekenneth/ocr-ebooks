#!/usr/bin/env python3
"""對本地 RCUV 檔案逐章對比 Bible.com 源頁 usfm 節號，定性缺節：
MERGED   缺節屬跨節合併 block（源頁 1-2 合併排版，DOM 無節內分界）
ABSENT   源頁無此 usfm（版本不收：古卷異文/附錄/版本節號差異）
PARSER   源頁有獨立 usfm 但本地缺（真 parser 漏抓）
輸出 classify_missing_report.txt
"""
import json, glob, re, os, gzip, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from bs4 import BeautifulSoup
from rebuild_rcuv import CODE, _compress_spaces

VID=139; SLUG='RCUV'

def fetch_usfm(book_code, ch, retries=4):
    url=f'https://www.bible.com/bible/{VID}/{book_code}.{ch}.{SLUG}'
    for attempt in range(retries):
        try:
            req=urllib.request.Request(url, headers={'User-Agent':'Mozilla/5.0','Accept-Encoding':'gzip'})
            resp=urllib.request.urlopen(req,timeout=30); data=resp.read()
            if resp.headers.get('Content-Encoding')=='gzip': data=gzip.decompress(data)
            soup=BeautifulSoup(data.decode('utf-8'),'html.parser')
            content=soup.find('div',{'data-testid':'chapter-content'})
            if not content: return {}, []
            for note in content.find_all('span',class_='cat7xG_note'): note.extract()
            single=set(); merged=[]  # merged: (range tuple of ints, usfm)
            for block in content.find_all('span',class_='cat7xG_verse'):
                u=block.get('data-usfm') or ''
                parts=u.split('+')
                nums=[]
                for p in parts:
                    m=re.search(r'\.(\d+)$',p)
                    if m: nums.append(int(m.group(1)))
                if len(nums)>1: merged.append(tuple(nums))
                elif nums: single.add(nums[0])
            return single, merged
        except Exception:
            if attempt==retries-1: return None, None
            time.sleep(3)

def main():
    report=[]; totals={'MERGED':0,'ABSENT':0,'PARSER':0,'FETCH_ERR':0}
    detail={'MERGED':[],'ABSENT':[],'PARSER':[],'FETCH_ERR':[]}
    files=sorted(glob.glob('books/聖經*.json'))
    tasks=[]
    local={}
    for f in files:
        b=json.load(open(f)); title=b['book_title']
        short=title.split(' - ',1)[1] if ' - ' in title else title
        if short=='目錄' or short not in CODE: continue
        code=CODE[short]
        by=json.loads(json.dumps({}))  # placeholder
        chapters={}
        for r in b['rows']:
            if not str(r.get('topic','')).isdigit(): continue
            chapters.setdefault(r['chapter'],set()).add(int(r['topic']))
        local[short]=(code,chapters)
    # flatten tasks（chapter 欄位係中文數字「第一章」；rows 按章序插入，dict 保留順序）
    flat=[]
    for short,(code,chapters) in local.items():
        for idx,chname in enumerate(chapters.keys(), start=1):
            flat.append((short,code,idx,chname,chapters[chname]))
    print(f'total chapters: {len(flat)}', flush=True)

    def job(item):
        short,code,ch,chname,vnums=item
        single,merged=fetch_usfm(code,ch)
        return short,chname,vnums,single,merged

    results=[]
    with ThreadPoolExecutor(max_workers=5) as ex:
        for i,res in enumerate(ex.map(job,flat)):
            results.append(res)
            if i%100==0: print(f'  {i}/{len(flat)}',flush=True)

    for short,chname,vnums,single,merged in results:
        if single is None:
            totals['FETCH_ERR']+=1; detail['FETCH_ERR'].append(f'{short} {chname}'); continue
        src=single
        merged_ranges=[(m[0],m[-1]) for m in merged]
        last=max(src) if src else 0
        for lo,hi in merged_ranges: last=max(last,hi)
        for n in range(1,last+1):
            if n in vnums: continue
            if any(lo<=n<=hi for lo,hi in merged_ranges):
                cat='MERGED'
            elif n in src:
                cat='PARSER'
            else:
                cat='ABSENT'
            totals[cat]+=1
            detail[cat].append(f'{short} {chname}:{n}')

    lines=['缺節定性報告（本地檔案 vs Bible.com vid=139 源頁 usfm）','',
           f"MERGED 跨節合併排版: {totals['MERGED']}",
           f"ABSENT 版本不收（古卷異文/附錄/節號差異）: {totals['ABSENT']}",
           f"PARSER 真漏抓: {totals['PARSER']}",
           f"FETCH_ERR 源頁抓取失敗: {totals['FETCH_ERR']}",'']
    for cat in ['PARSER','ABSENT','MERGED','FETCH_ERR']:
        lines.append(f'=== {cat} ({len(detail[cat])}) ===')
        lines+=['  '+x for x in detail[cat]] or ['  (無)']
        lines.append('')
    out='\n'.join(lines)
    print(out)
    open('classify_missing_report.txt','w',encoding='utf-8').write(out+'\n')

if __name__=='__main__':
    main()
