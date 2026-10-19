#!/usr/bin/env python3
"""Build the offline Android lab APK using the already-installed SDK/NDK.
All build outputs, signing material and logs stay inside lab/android/.
"""
from pathlib import Path
import datetime,json,os,shutil,subprocess,sys,zipfile

ROOT=Path(__file__).resolve().parents[1]
SDK=Path(os.environ.get('ANDROID_SDK_ROOT',str(Path.home()/'Desktop/android_sdk/android-sdk-macosx')))
BUILD=ROOT/'build'; RESULTS=ROOT/'results'; BUILD.mkdir(exist_ok=True);RESULTS.mkdir(exist_ok=True)
env=os.environ.copy()
if Path('/opt/homebrew/opt/openjdk@17').exists():env['JAVA_HOME']='/opt/homebrew/opt/openjdk@17'
JAVA=Path(env.get('JAVA_HOME','/opt/homebrew/opt/openjdk@17'))/'bin'
BT=SDK/'build-tools/36.0.0'; ANDROID=SDK/'platforms/android-35/android.jar'
if not ANDROID.exists():ANDROID=SDK/'platforms/android-36/android.jar'
CMAKE=SDK/'cmake/3.22.1/bin/cmake';NINJA=SDK/'cmake/3.22.1/bin/ninja'
NDK=SDK/'ndk/27.1.12297006'

def local_config():
    values={}
    path=ROOT/'.env'
    if path.exists():
        for raw in path.read_text(encoding='utf-8').splitlines():
            line=raw.strip()
            if not line or line.startswith('#') or '=' not in line:continue
            key,value=line.split('=',1);values[key.strip()]=value.strip().strip('"').strip("'")
    rpc=values.get('base-sepolia-node','')
    if rpc and not rpc.startswith('https://'):
        raise SystemExit('base-sepolia-node 必须使用 HTTPS')
    return rpc

generated=BUILD/'generated/im/privatememo/lab'
generated.mkdir(parents=True,exist_ok=True)
(generated/'RuntimeConfig.java').write_text(
    'package im.privatememo.lab;\nfinal class RuntimeConfig {\n'
    f'  static final String MEMO_RPC_URL={json.dumps(local_config())};\n'
    '}\n',encoding='utf-8')

def run(args):
    args=[str(a) for a in args]
    # Keep this script usable with the macOS system Python (3.8), where
    # zoneinfo is not available.  The experiment phone and host are both in
    # Asia/Shanghai, which has a fixed UTC+08:00 offset.
    china_tz=datetime.timezone(datetime.timedelta(hours=8),name='Asia/Shanghai')
    with (RESULTS/'build-events.jsonl').open('a') as f:f.write(json.dumps({'at':datetime.datetime.now(china_tz).isoformat(),'argv':args},ensure_ascii=False)+'\n')
    print('RUN',args[0],flush=True)
    with (RESULTS/'android-build.log').open('a') as log:
        p=subprocess.run(args,cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT)
    if p.returncode:
        print('\n'.join((RESULTS/'android-build.log').read_text(errors='replace').splitlines()[-50:]))
        raise SystemExit(p.returncode)

run([CMAKE,'-S',ROOT/'cpp','-B',BUILD/'native','-G','Ninja',f'-DCMAKE_MAKE_PROGRAM={NINJA}',f'-DCMAKE_TOOLCHAIN_FILE={NDK}/build/cmake/android.toolchain.cmake','-DANDROID_ABI=arm64-v8a','-DANDROID_PLATFORM=android-28','-DANDROID_STL=c++_static','-DCMAKE_BUILD_TYPE=Release'])
run([CMAKE,'--build',BUILD/'native','--target','memo_native','-j','6'])
classes=BUILD/'classes'
if classes.exists():shutil.rmtree(classes)
classes.mkdir()
run([JAVA/'javac','-encoding','UTF-8','-source','11','-target','11','-classpath',str(ANDROID)+os.pathsep+str(ROOT/'vendor/zxing-core-3.5.3.jar'),'-d',classes,*sorted((ROOT/'src').glob('*.java')),generated/'RuntimeConfig.java'])
run([JAVA/'jar','cf',BUILD/'classes.jar','-C',classes,'.'])
dex=BUILD/'dex'
if dex.exists():shutil.rmtree(dex)
dex.mkdir()
run([BT/'d8','--lib',ANDROID,'--min-api','28','--output',dex,BUILD/'classes.jar',ROOT/'vendor/zxing-core-3.5.3.jar'])
resources=BUILD/'resources.zip'
if resources.exists():resources.unlink()
run([BT/'aapt2','compile','--dir',ROOT/'res','-o',resources])
run([BT/'aapt2','link','-I',ANDROID,'--manifest',ROOT/'AndroidManifest.xml','--auto-add-overlay','-R',resources,'-o',BUILD/'unsigned.apk'])
with zipfile.ZipFile(BUILD/'unsigned.apk','a',zipfile.ZIP_DEFLATED) as z:
    for p in dex.glob('*.dex'):z.write(p,p.name)
    z.write(BUILD/'native/libmemo_native.so','lib/arm64-v8a/libmemo_native.so')
    for name in ['libsherpa-onnx-c-api.so','libonnxruntime.so']:
        p=ROOT/'vendor/jniLibs/arm64-v8a'/name;z.write(p,'lib/arm64-v8a/'+name)
run([BT/'zipalign','-f','-p','4',BUILD/'unsigned.apk',BUILD/'aligned.apk'])
key=BUILD/'lab-debug.keystore'
if not key.exists():run([JAVA/'keytool','-genkeypair','-keystore',key,'-storepass','android','-keypass','android','-alias','lab','-keyalg','RSA','-keysize','2048','-validity','3650','-dname','CN=Private Memo Lab'])
apk=BUILD/'private-memo-lab.apk'
run([BT/'apksigner','sign','--ks',key,'--ks-key-alias','lab','--ks-pass','pass:android','--key-pass','pass:android','--out',apk,BUILD/'aligned.apk'])
run([BT/'apksigner','verify','--verbose',apk])
print('APK',apk,'bytes',apk.stat().st_size)
