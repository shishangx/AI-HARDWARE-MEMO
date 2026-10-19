#!/usr/bin/env python3
"""Record a single experiment command and its unmodified stdout/stderr.
Usage: python3 record_command.py LABEL COMMAND ARG...
Do not use for commands containing wallet secrets or private user content.
"""
from pathlib import Path
from zoneinfo import ZoneInfo
import datetime,json,subprocess,sys,time
r=Path(__file__).resolve().parents[1]/'results';r.mkdir(exist_ok=True)
label=sys.argv[1];argv=sys.argv[2:]
if not argv:raise SystemExit('missing command')
start=time.monotonic();at=datetime.datetime.now(ZoneInfo('Asia/Shanghai')).isoformat()
with (r/(label+'.stdout.txt')).open('w') as out,(r/(label+'.stderr.txt')).open('w') as err:
    p=subprocess.run(argv,stdout=out,stderr=err)
entry={'at':at,'label':label,'argv':argv,'exit_code':p.returncode,'elapsed_seconds':time.monotonic()-start}
with (r/'commands.jsonl').open('a') as f:f.write(json.dumps(entry,ensure_ascii=False)+'\n')
print(json.dumps(entry,ensure_ascii=False))
if p.returncode:print((r/(label+'.stderr.txt')).read_text(errors='replace')[-3000:])
raise SystemExit(p.returncode)
