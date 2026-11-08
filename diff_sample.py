#!/usr/bin/env python3
"""逐節對校：現有 414 混版檔案 vs RCUV vid=139 樣本，輸出差異統計與典型例子。"""
import json, glob, re, collections, sys

def norm(s):
    s = re.sub(r'[\s。，；：！？「」『』、－—·#]', '', s)
    return s

def load(path):
    b = json.load(open(path))
    out = {}
    for r in b['rows']:
        out[(r['chapter'], r['topic'])] = r['content']
    return out

old = load([x for x in glob.glob('books/*.json') if '創世紀' in x][0])
new = load([x for x in glob.glob('books_rcuv/*.json') if '創世紀' in x][0])

old_keys = set(old); new_keys = set(new)
only_old = sorted(old_keys - new_keys)
only_new = sorted(new_keys - old_keys)

identical = 0
punct_only = 0
text_diff = []
for k in sorted(old_keys & new_keys, key=lambda x: (x[0], int(x[1]))):
    o, n = old[k], new[k]
    if o == n:
        identical += 1
    elif norm(o) == norm(n):
        punct_only += 1
    else:
        text_diff.append((k, o, n))

print('=== 節數對齊 ===')
print(f'現有檔案節數: {len(old)} | RCUV 樣本節數: {len(new)}')
print(f'僅現有有: {len(only_old)} | 僅樣本有: {len(only_new)}')
print()
print('=== 逐節一致率 ===')
print(f'完全一致: {identical}')
print(f'僅標點/空格差異: {punct_only}')
print(f'文本用字差異: {len(text_diff)}')
total = len(old_keys & new_keys)
print(f'一致率(完全+標點): {(identical+punct_only)/total*100:.1f}%')
print()

# 差異分類：舊詞彙 vs 修訂詞彙
old_markers = ['空氣','淵面','頭一日','諸水','發生青草','包著核','菜蔬','看見是好','看著是好']
new_markers = ['穹蒼','深淵上面一片黑暗','第一日','眾水','長出植物','果子裏有種子','五穀菜蔬','看為好']
old_hit = collections.Counter()
for k,o,n in text_diff:
    for m in old_markers:
        if m in o: old_hit[m]+=1
print('=== 差異中殘留舊和合本詞彙出現次數 ===')
for m,c in old_hit.most_common():
    print(f'  {m}: {c}')
print()

print('=== 典型文本差異（前 25 節）===')
for (ch, v), o, n in text_diff[:25]:
    print(f'[{ch} {v}]')
    print(f'  現有: {o[:80]}')
    print(f'  RCUV: {n[:80]}')

# 存完整差異清單
with open('diff_genesis_rcuv.txt','w',encoding='utf-8') as f:
    f.write(f'現有節數 {len(old)} / 樣本 {len(new)}；完全一致 {identical}，標點差異 {punct_only}，文本差異 {len(text_diff)}\n\n')
    for (ch,v),o,n in text_diff:
        f.write(f'[{ch} {v}]\n現有: {o}\nRCUV: {n}\n\n')
print('\n完整清單: diff_genesis_rcuv.txt')
