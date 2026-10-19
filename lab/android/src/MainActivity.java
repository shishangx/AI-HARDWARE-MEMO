package im.privatememo.lab;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.*;
import android.graphics.drawable.GradientDrawable;
import android.media.MediaPlayer;
import android.net.*;
import android.os.*;
import android.provider.Settings;
import android.view.*;
import android.widget.*;
import com.google.zxing.*;
import com.google.zxing.common.*;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.text.SimpleDateFormat;
import java.util.*;
import java.util.concurrent.*;

public class MainActivity extends Activity {
  static final String[] MODELS={"paraformer","sensevoice","r2t2"};
  static final String DEFAULT_LLM_BEARER="a7cefa8436eea38049d5e1951c6db23188b6d9e5fa9693eec4d97919881521e9";
  static final int MEMO_CHAIN_ID=84532;
  static final String MEMO_CONTRACT="0x2737FAedBf625BF32069A7a076A6C42644292278";
  static final String MEMO_PAGE="https://ai-hardware-gamma.vercel.app/";
  static final String MEMO_DEPLOY_BLOCK="0x2df3da5";
  static final int REQUEST_CAMERA_PERMISSION=31;
  static final int CASE=Color.rgb(27,28,30), SCREEN=Color.rgb(13,18,12), TITLE=Color.rgb(24,32,21), PRESSED=Color.rgb(35,49,30);
  static final int FG=Color.rgb(207,232,196), DIM=Color.rgb(138,152,132), ACCENT=Color.rgb(134,198,92), DANGER=Color.rgb(235,130,110);
  final ExecutorService worker=Executors.newSingleThreadExecutor();
  final Handler main=new Handler(Looper.getMainLooper());
  File base,results,recordings,transcripts,summaries; TextView stateView,content,recordingTimer,screenTitleView,screenActionView; LinearLayout list,deviceRoot; ScrollView scrollView;
  boolean busy=false,useVad=true; int modelIndex=0; MediaPlayer player; File playingFile;
  TextView playbackTitle,playbackSub; OrbitalView recordingOrb;

  @Override public void onCreate(Bundle b){
    super.onCreate(b);base=getExternalFilesDir(null);results=dir("results");recordings=dir("recordings");transcripts=dir("transcripts");summaries=dir("summaries");
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);getWindow().setStatusBarColor(CASE);getWindow().setNavigationBarColor(CASE);
    getWindow().getDecorView().setSystemUiVisibility(0);showHome();handleIntent(getIntent());
  }
  @Override protected void onNewIntent(Intent i){super.onNewIntent(i);setIntent(i);handleIntent(i);}
  @Override protected void onDestroy(){stopPlayback();worker.shutdownNow();super.onDestroy();}
  File dir(String name){File f=new File(base,name);f.mkdirs();return f;}
  int dp(int n){return Math.round(n*getResources().getDisplayMetrics().density);}
  TextView text(String value,int sp,int color){TextView v=new TextView(this);v.setText(value);v.setTextSize(sp);v.setTextColor(color);v.setTypeface(Typeface.create("sans",Typeface.NORMAL));v.setLineSpacing(0,1.12f);return v;}
  TextView mono(String value,int sp,int color){TextView v=text(value,sp,color);v.setTypeface(Typeface.MONOSPACE);return v;}
  GradientDrawable bg(int color,float radius){GradientDrawable g=new GradientDrawable();g.setColor(color);g.setCornerRadius(dp((int)radius));return g;}

  void screen(String title,Runnable back){
    LinearLayout outer=new LinearLayout(this);outer.setOrientation(LinearLayout.VERTICAL);outer.setPadding(dp(15),dp(12),dp(15),dp(14));outer.setBackgroundColor(CASE);
    outer.setOnApplyWindowInsetsListener((v,insets)->{
      int top,bottom;
      if(Build.VERSION.SDK_INT>=30){android.graphics.Insets bars=insets.getInsets(WindowInsets.Type.systemBars()|WindowInsets.Type.displayCutout());top=bars.top;bottom=bars.bottom;}
      else{top=insets.getSystemWindowInsetTop();bottom=insets.getSystemWindowInsetBottom();}
      v.setPadding(dp(15),top+dp(8),dp(15),bottom+dp(10));return insets;
    });
    LinearLayout device=new LinearLayout(this);deviceRoot=device;device.setOrientation(LinearLayout.VERTICAL);device.setBackground(bg(SCREEN,20));device.setPadding(dp(2),dp(2),dp(2),dp(8));outer.addView(device,new LinearLayout.LayoutParams(-1,-1));
    LinearLayout bar=new LinearLayout(this);bar.setGravity(Gravity.CENTER_VERTICAL);bar.setPadding(dp(14),dp(8),dp(14),dp(8));bar.setBackgroundColor(TITLE);
    TextView clock=mono("PRIVATE MEMO",11,DIM);bar.addView(clock);
    stateView=mono("● READY",12,ACCENT);stateView.setGravity(Gravity.RIGHT);bar.addView(stateView,new LinearLayout.LayoutParams(0,-2,1));device.addView(bar);
    LinearLayout titleBar=new LinearLayout(this);titleBar.setGravity(Gravity.CENTER_VERTICAL);titleBar.setPadding(dp(9),dp(12),dp(12),dp(12));
    if(back!=null){TextView b=text("‹",26,ACCENT);b.setGravity(Gravity.CENTER);b.setPadding(dp(5),dp(5),dp(14),dp(5));b.setOnClickListener(v->back.run());titleBar.addView(b);}
    TextView t=text(title,18,FG);t.setTypeface(Typeface.MONOSPACE,Typeface.BOLD);screenTitleView=t;titleBar.addView(t,new LinearLayout.LayoutParams(0,-2,1));
    screenActionView=text("",13,ACCENT);screenActionView.setGravity(Gravity.CENTER);screenActionView.setPadding(dp(12),dp(8),dp(4),dp(8));screenActionView.setVisibility(View.GONE);titleBar.addView(screenActionView);device.addView(titleBar);
    View line=new View(this);line.setBackgroundColor(DIM);device.addView(line,new LinearLayout.LayoutParams(-1,dp(1)));
    ScrollView scroll=new ScrollView(this);scrollView=scroll;list=new LinearLayout(this);list.setOrientation(LinearLayout.VERTICAL);list.setPadding(dp(10),dp(10),dp(10),dp(24));scroll.addView(list);device.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));setContentView(outer);
  }
  void screenAction(String label,int color,Runnable action){screenActionView.setText(label);screenActionView.setTextColor(color);screenActionView.setVisibility(View.VISIBLE);screenActionView.setOnClickListener(v->action.run());}
  LinearLayout row(String label,String sub,Runnable action){
    LinearLayout r=new LinearLayout(this);r.setOrientation(LinearLayout.VERTICAL);r.setPadding(dp(14),dp(13),dp(12),dp(13));r.setBackground(bg(TITLE,8));
    TextView a=text(label,16,FG);r.addView(a);if(sub!=null&&!sub.isEmpty()){TextView s=text(sub,12,DIM);s.setPadding(0,dp(4),0,0);r.addView(s);}
    if(action!=null){r.setClickable(true);r.setOnClickListener(v->action.run());r.setOnTouchListener((v,e)->{v.setBackground(bg(e.getAction()==MotionEvent.ACTION_DOWN?PRESSED:TITLE,8));return false;});}
    LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,-2);p.setMargins(0,0,0,dp(8));list.addView(r,p);return r;
  }
  void note(String s){TextView v=text(s,13,DIM);v.setPadding(dp(8),dp(8),dp(8),dp(16));list.addView(v);}
  void output(String s){content=text(s,14,FG);content.setTextIsSelectable(true);content.setPadding(dp(10),dp(12),dp(10),dp(18));list.addView(content);}
  String selected(){return MODELS[modelIndex];}
  static String fmt(double x){return String.format(Locale.US,"%.2f",x);}
  void state(String s){main.post(()->{if(stateView!=null)stateView.setText(s);});}
  void show(String s){main.post(()->{if(content!=null)content.setText(s);});}

  void showHome(){
    screen("PRIVATE MEMO",null);addHomeHero();compactRow("录音文件",String.valueOf(count(recordings,".wav")),latestSummary(recordings,".wav"),this::showRecordings);compactRow("转写文本",String.valueOf(count(transcripts,".json")),latestTranscriptSummary(),this::showTranscripts);compactRow("每日摘要",String.valueOf(count(summaries,".json")),latestDailySummary(),this::showDailySummaries);
    View divider=new View(this);divider.setBackgroundColor(Color.rgb(49,61,45));LinearLayout.LayoutParams dpv=new LinearLayout.LayoutParams(-1,dp(1));dpv.setMargins(dp(2),dp(10),dp(2),dp(8));list.addView(divider,dpv);
    slimRow("▣  钱包与二维码",pairSummary(),this::showWallet);slimRow("⚙  实验设置",providerSummary(),this::showSettings);
  }
  void addHomeHero(){LinearLayout hero=new LinearLayout(this);hero.setOrientation(LinearLayout.VERTICAL);hero.setGravity(Gravity.CENTER);hero.setPadding(0,dp(8),0,dp(20));OrbitalView orb=new OrbitalView(this);orb.setMode(AudioCaptureService.recording?(AudioCaptureService.paused?OrbitalView.PAUSED:OrbitalView.RECORDING):OrbitalView.HOME);hero.addView(orb,new LinearLayout.LayoutParams(dp(230),dp(230)));TextView title=text(AudioCaptureService.recording?(AudioCaptureService.paused?"录音已暂停":"正在录音中"):"开始录音",23,FG);title.setTypeface(Typeface.create("sans",Typeface.BOLD));title.setGravity(Gravity.CENTER);hero.addView(title);TextView sub=mono(AudioCaptureService.recording?AudioCaptureService.timer():"最长 5 分钟 · 录音保存在本机",13,DIM);sub.setGravity(Gravity.CENTER);sub.setPadding(0,dp(6),0,0);hero.addView(sub);hero.setClickable(true);hero.setOnClickListener(v->{if(AudioCaptureService.recording)showRecorder();else startRecording(0);});list.addView(hero,new LinearLayout.LayoutParams(-1,-2));}
  String latestSummary(File d,String suffix){File[] fs=sorted(d,suffix);return fs.length==0?"还没有内容":"最近："+when(fs[0].lastModified());}
  String latestTranscriptSummary(){File[] fs=sorted(transcripts,".json");if(fs.length==0)return "还没有内容";try{JSONObject j=readJson(fs[0]);String model=j.optString("model","未知模型").trim();if(model.isEmpty())model="未知模型";return "最近："+model+" · "+when(fs[0].lastModified());}catch(Exception e){return "最近记录读取失败";}}
  String latestDailySummary(){File[] fs=sorted(summaries,".json");if(fs.length==0)return "尚未生成 · 可手动或自动更新";try{JSONObject j=readJson(fs[0]);return "最近："+j.optString("date")+" · "+j.optInt("transcript_count")+" 条记录";}catch(Exception e){return "最近摘要读取失败";}}
  void compactRow(String label,String count,String sub,Runnable action){LinearLayout r=new LinearLayout(this);r.setGravity(Gravity.CENTER_VERTICAL);r.setPadding(dp(14),dp(13),dp(12),dp(13));r.setBackground(bg(TITLE,10));LinearLayout words=new LinearLayout(this);words.setOrientation(LinearLayout.VERTICAL);TextView a=text(label,17,FG);a.setTypeface(Typeface.create("sans",Typeface.BOLD));words.addView(a);TextView s=mono(sub,12,DIM);s.setPadding(0,dp(4),0,0);words.addView(s);r.addView(words,new LinearLayout.LayoutParams(0,-2,1));TextView n=mono(count,18,FG);n.setPadding(dp(8),0,dp(10),0);r.addView(n);TextView chevron=text("›",25,DIM);r.addView(chevron);r.setOnClickListener(v->action.run());r.setOnTouchListener((v,e)->{v.setBackground(bg(e.getAction()==MotionEvent.ACTION_DOWN?PRESSED:TITLE,10));return false;});LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,-2);p.setMargins(0,0,0,dp(8));list.addView(r,p);}
  void slimRow(String label,String sub,Runnable action){LinearLayout r=new LinearLayout(this);r.setGravity(Gravity.CENTER_VERTICAL);r.setPadding(dp(10),dp(12),dp(8),dp(12));TextView a=text(label,15,FG);r.addView(a,new LinearLayout.LayoutParams(0,-2,1));TextView c=text("›",24,DIM);r.addView(c);r.setOnClickListener(v->action.run());list.addView(r);TextView s=mono(sub,11,DIM);s.setPadding(dp(10),0,dp(8),dp(9));list.addView(s);}
  void showRecorder(){
    screen("录音",this::showHome);state(AudioCaptureService.paused?"Ⅱ PAUSED":"● RECORDING");
    TextView timer=mono(AudioCaptureService.timer(),40,FG);timer.setTypeface(Typeface.create(Typeface.MONOSPACE,Typeface.BOLD));timer.setGravity(Gravity.CENTER);timer.setPadding(0,dp(22),0,0);list.addView(timer);recordingTimer=timer;
    OrbitalView orb=new OrbitalView(this);recordingOrb=orb;orb.setMode(AudioCaptureService.paused?OrbitalView.PAUSED:OrbitalView.RECORDING);orb.setProgress(AudioCaptureService.recordedMillis()/300000f);LinearLayout.LayoutParams op=new LinearLayout.LayoutParams(-1,dp(265));op.setMargins(0,dp(2),0,0);list.addView(orb,op);
    TextView status=text(AudioCaptureService.paused?"录音已暂停":"正在录音中",19,AudioCaptureService.paused?DIM:FG);status.setTypeface(Typeface.create("sans",Typeface.BOLD));status.setGravity(Gravity.CENTER);status.setPadding(0,0,0,dp(24));list.addView(status);
    LinearLayout actions=new LinearLayout(this);actions.setGravity(Gravity.CENTER);TextView pause=pill(AudioCaptureService.paused?"▶ 继续":"Ⅱ  暂停",false,ACCENT);TextView stop=pill("■  停止并保存",true,ACCENT);pause.setOnClickListener(v->{startService(new Intent(this,AudioCaptureService.class).setAction(AudioCaptureService.paused?"resume":"pause"));main.postDelayed(this::showRecorder,120);});stop.setOnClickListener(v->stopRecording());LinearLayout.LayoutParams half=new LinearLayout.LayoutParams(0,dp(58),1);half.setMargins(dp(4),0,dp(4),0);actions.addView(pause,half);actions.addView(stop,half);list.addView(actions,new LinearLayout.LayoutParams(-1,-2));TextView hint=text("暂停期间不计入录音时长",12,DIM);hint.setGravity(Gravity.CENTER);hint.setPadding(0,dp(14),0,dp(8));list.addView(hint);
    main.postDelayed(new Runnable(){public void run(){if(recordingTimer!=timer)return;timer.setText(AudioCaptureService.timer());orb.setMode(AudioCaptureService.paused?OrbitalView.PAUSED:OrbitalView.RECORDING);orb.setProgress(AudioCaptureService.recordedMillis()/300000f);if(AudioCaptureService.recording){main.postDelayed(this,200);return;}recordingTimer=null;recordingOrb=null;if(!AudioCaptureService.error.isEmpty())error(new IOException(AudioCaptureService.error));else if(AudioCaptureService.lastFile!=null)showRecording(AudioCaptureService.lastFile);else showHome();}},200);
  }
  TextView pill(String label,boolean filled,int color){TextView v=text(label,15,filled?SCREEN:color);v.setTypeface(Typeface.create("sans",Typeface.BOLD));v.setGravity(Gravity.CENTER);GradientDrawable g=bg(filled?color:Color.TRANSPARENT,29);g.setStroke(dp(1),color);v.setBackground(g);return v;}
  int count(File d,String suffix){File[] fs=d.listFiles((x,n)->n.endsWith(suffix));return fs==null?0:fs.length;}
  String pairSummary(){try{JSONObject p=MemoCrypto.paired(this);if(p!=null)return "已配对 · "+shortAddress(p.getString("owner"));return MemoCrypto.hasStalePairing(this)?"需要重新配对 · 合约已升级":"未配对 · 真实存证二维码暂不可生成";}catch(Exception e){return "配对状态读取失败";}}
  String providerSummary(){try{JSONObject p=MemoCrypto.provider(this);if(p==null||!p.optBoolean("enabled"))return "内置 "+selected()+" · 本地 CPU 4 线程";String type=p.optString("type","openai_audio");return type.equals("lan_whisper")?"局域网 Whisper · "+Uri.parse(p.optString("endpoint")).getHost():"联网语音 · "+p.optString("model","已配置模型");}catch(Exception e){return "联网转写设置读取失败";}}
  String providerToggleSummary(){try{JSONObject p=MemoCrypto.provider(this);return p!=null&&p.optBoolean("enabled")?"已开启 · "+providerSummary():"已关闭 · 仅使用内置模型";}catch(Exception e){return "设置读取失败";}}
  String shortAddress(String a){return a.length()>12?a.substring(0,6)+"…"+a.substring(a.length()-4):a;}
  String memoReadPage(){String page=MEMO_PAGE+"?from="+MEMO_DEPLOY_BLOCK;if(!RuntimeConfig.MEMO_RPC_URL.isEmpty())page=MEMO_PAGE+"?rpc="+Uri.encode(RuntimeConfig.MEMO_RPC_URL)+"&from="+MEMO_DEPLOY_BLOCK;return page;}

  File[] sorted(File d,String suffix){File[] fs=d.listFiles((x,n)->n.endsWith(suffix));if(fs==null)return new File[0];Arrays.sort(fs,(a,b)->Long.compare(b.lastModified(),a.lastModified()));return fs;}
  void showRecordings(){
    screen("录音文件",this::showHome);File[] fs=sorted(recordings,".wav");
    if(fs.length==0){output("暂无录音");return;}
    screenAction("选择",ACCENT,this::showRecordingSelection);
    for(File f:fs)recordingRow(f,false,null);
  }
  void recordingRow(File f,boolean selection,CheckBox choice){LinearLayout r=new LinearLayout(this);r.setGravity(Gravity.CENTER_VERTICAL);r.setPadding(dp(12),dp(11),dp(10),dp(11));r.setBackground(bg(selection&&choice!=null&&choice.isChecked()?PRESSED:TITLE,10));if(selection&&choice!=null){choice.setButtonTintList(android.content.res.ColorStateList.valueOf(ACCENT));r.addView(choice,new LinearLayout.LayoutParams(dp(42),dp(48)));}else{TextView play=text(isPlaying(f)?"■":"▶",16,isPlaying(f)?ACCENT:FG);play.setGravity(Gravity.CENTER);r.addView(play,new LinearLayout.LayoutParams(dp(38),dp(48)));}
    LinearLayout words=new LinearLayout(this);words.setOrientation(LinearLayout.VERTICAL);TextView title=text(displayDate(f.lastModified()),16,FG);title.setTypeface(Typeface.create("sans",Typeface.BOLD));words.addView(title);TextView file=mono(f.getName(),11,DIM);file.setSingleLine(true);file.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);file.setPadding(0,dp(4),0,0);words.addView(file);r.addView(words,new LinearLayout.LayoutParams(0,-2,1));TextView len=mono(duration(f).replace(" 秒","s"),12,DIM);len.setPadding(dp(8),0,dp(2),0);r.addView(len);Runnable open=()->{if(selection&&choice!=null)choice.setChecked(!choice.isChecked());else showRecording(f);};r.setOnClickListener(v->open.run());if(choice!=null)choice.setOnClickListener(v->{r.setBackground(bg(choice.isChecked()?PRESSED:TITLE,10));});LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,-2);p.setMargins(0,0,0,dp(7));list.addView(r,p);}
  String displayDate(long t){Locale l=Locale.getDefault();String pattern=l.getLanguage().equals("zh")?"M 月 d 日  HH:mm":"MMM d,  HH:mm";return new SimpleDateFormat(pattern,l).format(new Date(t));}
  String duration(File f){try{return String.format(Locale.US,"%.1f 秒",Wav.read(f).length/16000.0);}catch(Exception e){return "时长未知";}}
  String when(long t){return new SimpleDateFormat("MM-dd HH:mm",Locale.getDefault()).format(new Date(t));}
  void showRecording(File f){
    screen("录音详情",this::showRecordings);note(f.getName()+"\n"+duration(f)+" · "+when(f.lastModified()));
    LinearLayout playback=row(isPlaying(f)?"■ 停止播放":"▶ 播放录音",isPlaying(f)?playbackProgress():"从本机文件播放",()->togglePlayback(f));
    playbackTitle=(TextView)playback.getChildAt(0);playbackSub=playback.getChildCount()>1?(TextView)playback.getChildAt(1):null;if(isPlaying(f))tickPlayback(f);
    row("转写为文本",providerSummary(),()->transcribeToLibrary(f,selected()));
    row("重命名录音","修改显示名称并保留 WAV 格式",()->renameRecording(f));
    row("删除录音","删除前会再次确认",()->new AlertDialog.Builder(this).setTitle("删除这条录音？").setMessage(f.getName()+"\n已有转写文本不会被删除。").setNegativeButton("取消",null).setPositiveButton("删除",(d,w)->{if(f.equals(playingFile))stopPlayback();if(f.delete())showRecordings();}).show());
  }
  boolean isPlaying(File f){return player!=null&&playingFile!=null&&playingFile.equals(f)&&player.isPlaying();}
  String playbackProgress(){if(player==null)return "";return String.format(Locale.US,"%02d:%02d / %02d:%02d",player.getCurrentPosition()/60000,(player.getCurrentPosition()/1000)%60,player.getDuration()/60000,(player.getDuration()/1000)%60);}
  void togglePlayback(File f){if(isPlaying(f)){stopPlayback();return;}play(f);}
  void play(File f){try{stopPlayback();player=new MediaPlayer();playingFile=f;player.setDataSource(f.toString());player.prepare();player.setOnCompletionListener(p->stopPlayback());player.start();state("▶ PLAYING");updatePlaybackControls(f);tickPlayback(f);}catch(Exception e){stopPlayback();error(e);}}
  void stopPlayback(){MediaPlayer old=player;player=null;playingFile=null;if(old!=null){try{old.stop();}catch(Exception ignored){}old.release();}state("● READY");if(playbackTitle!=null){playbackTitle.setText("▶ 播放录音");if(playbackSub!=null)playbackSub.setText("从本机文件播放");}}
  void updatePlaybackControls(File f){if(playbackTitle==null)return;playbackTitle.setText(isPlaying(f)?"■ 停止播放":"▶ 播放录音");if(playbackSub!=null)playbackSub.setText(isPlaying(f)?playbackProgress():"从本机文件播放");}
  void tickPlayback(File f){main.postDelayed(new Runnable(){public void run(){if(!isPlaying(f)||playbackTitle==null)return;updatePlaybackControls(f);main.postDelayed(this,250);}},250);}

  void renameRecording(File f){
    Dialog dialog=new Dialog(this);LinearLayout panel=new LinearLayout(this);panel.setOrientation(LinearLayout.VERTICAL);panel.setPadding(dp(22),dp(16),dp(22),dp(18));GradientDrawable panelBg=bg(TITLE,22);panelBg.setStroke(dp(1),DIM);panel.setBackground(panelBg);TextView handle=text("—",18,DIM);handle.setGravity(Gravity.CENTER);panel.addView(handle);
    TextView heading=text("重命名录音",21,FG);heading.setTypeface(Typeface.create("sans",Typeface.BOLD));heading.setPadding(0,dp(4),0,0);panel.addView(heading);TextView help=text("输入易于识别的名称",13,DIM);help.setPadding(0,dp(8),0,dp(14));panel.addView(help);
    LinearLayout fieldWrap=new LinearLayout(this);fieldWrap.setGravity(Gravity.CENTER_VERTICAL);GradientDrawable field=bg(SCREEN,9);field.setStroke(dp(1),ACCENT);fieldWrap.setBackground(field);EditText input=new EditText(this);String old=f.getName();input.setText(old.toLowerCase(Locale.US).endsWith(".wav")?old.substring(0,old.length()-4):old);input.setSelectAllOnFocus(true);input.setSingleLine(true);input.setTextColor(FG);input.setHintTextColor(DIM);input.setTypeface(Typeface.create("sans",Typeface.NORMAL));input.setTextSize(16);input.setPadding(dp(14),dp(12),dp(8),dp(12));input.setBackgroundColor(Color.TRANSPARENT);fieldWrap.addView(input,new LinearLayout.LayoutParams(0,-2,1));TextView suffix=mono(".wav",15,DIM);suffix.setPadding(dp(8),0,dp(14),0);fieldWrap.addView(suffix);panel.addView(fieldWrap,new LinearLayout.LayoutParams(-1,-2));
    LinearLayout feedback=new LinearLayout(this);feedback.setGravity(Gravity.CENTER_VERTICAL);TextView validation=text("",12,DANGER);feedback.addView(validation,new LinearLayout.LayoutParams(0,-2,1));TextView chars=mono(input.length()+" / 64",12,DIM);feedback.addView(chars);feedback.setPadding(dp(2),dp(8),dp(2),0);panel.addView(feedback);input.addTextChangedListener(new android.text.TextWatcher(){public void beforeTextChanged(CharSequence s,int a,int b,int c){}public void onTextChanged(CharSequence s,int a,int b,int c){chars.setText(s.length()+" / 64");validation.setText("");}public void afterTextChanged(android.text.Editable e){}});
    LinearLayout actions=new LinearLayout(this);actions.setGravity(Gravity.RIGHT);actions.setPadding(0,dp(16),0,0);TextView cancel=pill("取消",false,DIM);TextView save=pill("保存",true,ACCENT);LinearLayout.LayoutParams bp=new LinearLayout.LayoutParams(dp(126),dp(52));bp.setMargins(dp(6),0,0,0);actions.addView(cancel,bp);actions.addView(save,bp);panel.addView(actions);
    dialog.setContentView(panel);Window window=dialog.getWindow();if(window!=null){window.setBackgroundDrawableResource(android.R.color.transparent);window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);WindowManager.LayoutParams lp=window.getAttributes();lp.dimAmount=.72f;window.setAttributes(lp);}cancel.setOnClickListener(v->dialog.dismiss());save.setOnClickListener(v->{
      String name=input.getText().toString().trim();if(name.toLowerCase(Locale.US).endsWith(".wav"))name=name.substring(0,name.length()-4).trim();
      if(name.isEmpty()||name.length()>64||name.contains("/")||name.contains("\\")||name.indexOf('\0')>=0){validation.setText("请输入 1–64 个字符，不能包含 / 或 \\");return;}
      File target=new File(recordings,name+".wav");if(target.exists()&&!target.equals(f)){validation.setText("已有同名录音");return;}
      if(f.renameTo(target)){updateTranscriptAudioName(f.getName(),target.getName());if(f.equals(playingFile))playingFile=target;dialog.dismiss();showRecording(target);}else validation.setText("重命名失败，请重试");
    });dialog.setOnShowListener(x->{Window w=dialog.getWindow();if(w!=null){w.setGravity(Gravity.BOTTOM);w.getDecorView().setPadding(dp(12),0,dp(12),dp(12));w.setLayout(-1,-2);input.requestFocus();w.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE);}});dialog.show();
  }
  void updateTranscriptAudioName(String oldName,String newName){for(File t:sorted(transcripts,".json")){try{JSONObject j=readJson(t);if(oldName.equals(j.optString("audio_file"))){j.put("audio_file",newName);writeJson(t,j);}}catch(Exception ignored){}}}
  void showRecordingSelection(){
    screen("已选择 0 项",this::showRecordings);File[] fs=sorted(recordings,".wav");LinkedHashSet<File> selectedFiles=new LinkedHashSet<>();ArrayList<CheckBox> boxes=new ArrayList<>();
    LinearLayout selectionHeader=new LinearLayout(this);selectionHeader.setGravity(Gravity.CENTER_VERTICAL);selectionHeader.setPadding(dp(8),0,dp(8),dp(10));TextView hint=text("轻触整行进行选择",13,DIM);selectionHeader.addView(hint,new LinearLayout.LayoutParams(0,-2,1));TextView all=text("全选",14,ACCENT);all.setPadding(dp(16),dp(10),dp(4),dp(10));selectionHeader.addView(all);list.addView(selectionHeader);
    TextView countLabel=mono("已选择 0 项",13,DIM),delete=pill("删除",true,DANGER),cancel=pill("取消",false,DIM);Runnable update=()->{screenTitleView.setText("已选择 "+selectedFiles.size()+" 项");countLabel.setText("已选择 "+selectedFiles.size()+" 项");delete.setText(selectedFiles.isEmpty()?"删除":"删除 "+selectedFiles.size()+" 条录音");delete.setAlpha(selectedFiles.isEmpty()?.45f:1f);all.setText(selectedFiles.size()==fs.length?"取消全选":"全选");};
    for(File f:fs){CheckBox c=new CheckBox(this);c.setTag(f);c.setText("");c.setOnCheckedChangeListener((button,checked)->{if(checked)selectedFiles.add(f);else selectedFiles.remove(f);View parent=(View)button.getParent();if(parent!=null)parent.setBackground(bg(checked?PRESSED:TITLE,10));update.run();});recordingRow(f,true,c);boxes.add(c);}
    all.setOnClickListener(v->{boolean select=selectedFiles.size()!=fs.length;for(CheckBox c:boxes)c.setChecked(select);update.run();});cancel.setOnClickListener(v->showRecordings());delete.setOnClickListener(v->{if(selectedFiles.isEmpty())return;confirmDelete(selectedFiles);});
    LinearLayout bottom=new LinearLayout(this);bottom.setGravity(Gravity.CENTER_VERTICAL);bottom.setPadding(dp(12),dp(10),dp(12),dp(8));bottom.setBackgroundColor(TITLE);bottom.addView(cancel,new LinearLayout.LayoutParams(dp(92),dp(48)));countLabel.setGravity(Gravity.CENTER);bottom.addView(countLabel,new LinearLayout.LayoutParams(0,-2,1));bottom.addView(delete,new LinearLayout.LayoutParams(dp(158),dp(48)));deviceRoot.addView(bottom,new LinearLayout.LayoutParams(-1,-2));
  }
  void confirmDelete(Collection<File> files){new AlertDialog.Builder(this).setTitle("删除 "+files.size()+" 条录音？").setMessage("已有转写文本不会被删除。此操作不可撤销。").setNegativeButton("取消",null).setPositiveButton("删除",(d,w)->{for(File f:files){if(f.equals(playingFile))stopPlayback();f.delete();}showRecordings();}).show();}
  void transcribeToLibrary(File f,String model){if(busy){state("● WORKING");return;}showInfo("正在转写","正在读取本机录音并等待语音识别结果…\n\n请勿重复点击或关闭应用。",this::showRecordings);task(()->{JSONObject provider=MemoCrypto.provider(this);JSONObject j=provider!=null&&provider.optBoolean("enabled")?transcribeWithProvider(f,provider):transcribe(f,model,4,useVad);File saved=saveTranscript(j,f);log(j);if(autoDailySummary())try{generateDailySummary(dayOf(saved));}catch(Exception summaryError){log(new JSONObject().put("kind","daily_summary_error").put("error",summaryError.toString()));}main.post(()->showTranscript(saved));});}

  File saveTranscript(JSONObject j,File source)throws Exception{
    String id="tx-"+System.currentTimeMillis()+"-"+source.getName().replaceAll("[^A-Za-z0-9._-]","_");
    j.put("transcript_id",id).put("audio_file",source.getName()).put("created_at",new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX",Locale.US).format(new Date()));
    File f=new File(transcripts,id+".json");writeJson(f,j);return f;
  }
  void showTranscripts(){
    screen("转写文本",this::showHome);File[] fs=sorted(transcripts,".json");note("请选择一条文本。二维码始终从当前选择的文本生成，不受录音时间影响。");
    if(fs.length==0){output("暂无转写文本\n请先到“录音文件”中选择一条录音并转写。");return;}
    screenAction("选择",ACCENT,this::showTranscriptSelection);for(File f:fs)transcriptRow(f,false,null);
  }
  void transcriptRow(File f,boolean selection,CheckBox choice){
    String title=f.getName(),sub="记录读取失败";try{JSONObject j=readJson(f);title=j.optString("text").replace('\n',' ').trim();if(title.length()>34)title=title.substring(0,34)+"…";if(title.isEmpty())title="（未识别到语音）";sub=j.optString("model")+" · "+j.optString("audio_file")+" · "+when(f.lastModified());}catch(Exception ignored){}
    LinearLayout r=new LinearLayout(this);r.setGravity(Gravity.CENTER_VERTICAL);r.setPadding(dp(12),dp(11),dp(10),dp(11));r.setBackground(bg(selection&&choice!=null&&choice.isChecked()?PRESSED:TITLE,10));if(selection&&choice!=null){choice.setButtonTintList(android.content.res.ColorStateList.valueOf(ACCENT));r.addView(choice,new LinearLayout.LayoutParams(dp(42),dp(48)));}
    LinearLayout words=new LinearLayout(this);words.setOrientation(LinearLayout.VERTICAL);TextView heading=text(title,15,FG);heading.setTypeface(Typeface.create("sans",Typeface.BOLD));heading.setMaxLines(2);words.addView(heading);TextView detail=mono(sub,11,DIM);detail.setPadding(0,dp(4),0,0);detail.setMaxLines(2);words.addView(detail);r.addView(words,new LinearLayout.LayoutParams(0,-2,1));if(!selection){TextView chevron=text("›",24,DIM);r.addView(chevron);}Runnable open=()->{if(selection&&choice!=null)choice.setChecked(!choice.isChecked());else showTranscript(f);};r.setOnClickListener(v->open.run());if(choice!=null)choice.setOnClickListener(v->{r.setBackground(bg(choice.isChecked()?PRESSED:TITLE,10));});LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,-2);p.setMargins(0,0,0,dp(7));list.addView(r,p);
  }
  void showTranscriptSelection(){
    screen("已选择 0 项",this::showTranscripts);File[] fs=sorted(transcripts,".json");LinkedHashSet<File> selectedFiles=new LinkedHashSet<>();ArrayList<CheckBox> boxes=new ArrayList<>();
    LinearLayout selectionHeader=new LinearLayout(this);selectionHeader.setGravity(Gravity.CENTER_VERTICAL);selectionHeader.setPadding(dp(8),0,dp(8),dp(10));TextView hint=text("轻触整行进行选择",13,DIM);selectionHeader.addView(hint,new LinearLayout.LayoutParams(0,-2,1));TextView all=text("全选",14,ACCENT);all.setPadding(dp(16),dp(10),dp(4),dp(10));selectionHeader.addView(all);list.addView(selectionHeader);
    TextView countLabel=mono("已选择 0 项",13,DIM),delete=pill("删除",true,DANGER),cancel=pill("取消",false,DIM);Runnable update=()->{screenTitleView.setText("已选择 "+selectedFiles.size()+" 项");countLabel.setText("已选择 "+selectedFiles.size()+" 项");delete.setText(selectedFiles.isEmpty()?"删除":"删除 "+selectedFiles.size()+" 条文本");delete.setAlpha(selectedFiles.isEmpty()?.45f:1f);all.setText(selectedFiles.size()==fs.length?"取消全选":"全选");};
    for(File f:fs){CheckBox c=new CheckBox(this);c.setTag(f);c.setText("");c.setOnCheckedChangeListener((button,checked)->{if(checked)selectedFiles.add(f);else selectedFiles.remove(f);View parent=(View)button.getParent();if(parent!=null)parent.setBackground(bg(checked?PRESSED:TITLE,10));update.run();});transcriptRow(f,true,c);boxes.add(c);}all.setOnClickListener(v->{boolean select=selectedFiles.size()!=fs.length;for(CheckBox c:boxes)c.setChecked(select);update.run();});cancel.setOnClickListener(v->showTranscripts());delete.setOnClickListener(v->{if(selectedFiles.isEmpty())return;confirmDeleteTranscripts(selectedFiles);});
    LinearLayout bottom=new LinearLayout(this);bottom.setGravity(Gravity.CENTER_VERTICAL);bottom.setPadding(dp(12),dp(10),dp(12),dp(8));bottom.setBackgroundColor(TITLE);bottom.addView(cancel,new LinearLayout.LayoutParams(dp(92),dp(48)));countLabel.setGravity(Gravity.CENTER);bottom.addView(countLabel,new LinearLayout.LayoutParams(0,-2,1));bottom.addView(delete,new LinearLayout.LayoutParams(dp(158),dp(48)));deviceRoot.addView(bottom,new LinearLayout.LayoutParams(-1,-2));
  }
  void confirmDeleteTranscripts(Collection<File> files){new AlertDialog.Builder(this).setTitle("删除 "+files.size()+" 条转写文本？").setMessage("原录音会保留。此操作不可撤销。").setNegativeButton("取消",null).setPositiveButton("删除",(d,w)->{for(File f:files)f.delete();showTranscripts();}).show();}
  void showTranscript(File f){
    try{JSONObject j=readJson(f);screen("转写详情",this::showTranscripts);note("来源："+j.optString("audio_file")+"\n模型："+j.optString("model")+" · "+when(f.lastModified()));output(j.optString("text","（空文本）"));
      row("加密并生成二维码","使用当前选择的这条转写",()->task(()->createMemo(j,f)));
      row("删除转写文本","不会删除原录音",()->new AlertDialog.Builder(this).setTitle("删除这条转写？").setNegativeButton("取消",null).setPositiveButton("删除",(d,w)->{if(f.delete())showTranscripts();}).show());
    }catch(Exception e){error(e);}
  }

  boolean autoDailySummary(){return getSharedPreferences("private-memo",MODE_PRIVATE).getBoolean("auto_daily_summary",false);}
  void setAutoDailySummary(boolean enabled){if(enabled&&!canSummarize()){showInfo("尚未安装摘要模型","请将 Qwen3-0.6B Q4 模型放入本机模型目录后再开启自动摘要。",this::showSettings);return;}getSharedPreferences("private-memo",MODE_PRIVATE).edit().putBoolean("auto_daily_summary",enabled).apply();showSettings();}
  File localSummaryModel(){return new File(base,"models/summary/Qwen3-0.6B-Q4_K_M.gguf");}
  JSONObject enabledLlmProvider(){try{JSONObject p=MemoCrypto.provider(this);if(p!=null&&p.optBoolean("enabled")&&!p.optString("llmEndpoint").trim().isEmpty()&&!p.optString("llmModel").trim().isEmpty())return p;}catch(Exception ignored){}return null;}
  boolean canSummarize(){return localSummaryModel().isFile()||enabledLlmProvider()!=null;}
  String summaryEngineLabel(){if(localSummaryModel().isFile())return "本地 Qwen3-0.6B";JSONObject p=enabledLlmProvider();return p==null?"本地摘要模型未安装":"局域网 "+p.optString("llmModel")+"（测试）";}
  String today(){return new SimpleDateFormat("yyyy-MM-dd",Locale.US).format(new Date());}
  String dayOf(File f){try{String value=readJson(f).optString("created_at");if(value.length()>=10)return value.substring(0,10);}catch(Exception ignored){}return new SimpleDateFormat("yyyy-MM-dd",Locale.US).format(new Date(f.lastModified()));}
  TreeMap<String,ArrayList<File>> transcriptDays(){TreeMap<String,ArrayList<File>> days=new TreeMap<>(Collections.reverseOrder());for(File f:sorted(transcripts,".json"))days.computeIfAbsent(dayOf(f),x->new ArrayList<>()).add(f);return days;}
  File dailySummaryFile(String day){return new File(summaries,"daily-"+day+".json");}
  void showDailySummaries(){
    screen("每日摘要",this::showHome);TreeMap<String,ArrayList<File>> days=transcriptDays();String date=today();ArrayList<File> current=days.get(date);
    Runnable action=current==null||!canSummarize()?null:()->startDailySummary(date);LinearLayout hero=row("生成今日摘要",current==null?"今天还没有可用的转写文本":summaryEngineLabel()+" · "+current.size()+" 条转写 · "+(canSummarize()?"一键生成或更新":"请先安装模型"),action);hero.setPadding(dp(16),dp(17),dp(14),dp(17));
    if(localSummaryModel().isFile())note("摘要由设备内的 Qwen3-0.6B 生成，不发送录音或转写文本。自动模式会在每次新增转写后更新当天摘要；结果可能遗漏信息，请通过来源记录回看原文。");else if(enabledLlmProvider()!=null)note("当前使用已开启的局域网 LLM 测试摘要，所选日期的转写文本会发送到设置中的服务。关闭联网语音转写总开关后立即停用。量产默认使用本地 Qwen3-0.6B。");else note("尚未安装本地摘要模型。请将 Qwen3-0.6B Q4 模型放入设备模型目录后再生成摘要。");
    if(days.isEmpty()){output("暂无可摘要内容\n请先完成至少一条语音转写。");return;}
    for(Map.Entry<String,ArrayList<File>> entry:days.entrySet()){String day=entry.getKey();File saved=dailySummaryFile(day);String sub=saved.exists()?"已生成 · "+entry.getValue().size()+" 条转写 · "+when(saved.lastModified()):"待生成 · "+entry.getValue().size()+" 条转写";row(displaySummaryDate(day),sub,saved.exists()?()->showDailySummary(saved):()->startDailySummary(day));}
  }
  String displaySummaryDate(String day){try{Date d=new SimpleDateFormat("yyyy-MM-dd",Locale.US).parse(day);Locale l=Locale.getDefault();return new SimpleDateFormat(l.getLanguage().equals("zh")?"M 月 d 日 · EEEE":"EEEE, MMM d",l).format(d);}catch(Exception e){return day;}}
  void startDailySummary(String day){if(!canSummarize()){showInfo("无法生成摘要","本地 Qwen3-0.6B 尚未安装。",this::showDailySummaries);return;}showInfo("正在生成摘要",summaryEngineLabel()+" 正在整理 "+day+" 的多条转写。\n\n长内容会先分块提炼，再合并成每日摘要。",this::showDailySummaries);task(()->{File f=generateDailySummary(day);main.post(()->showDailySummary(f));});}
  File generateDailySummary(String day)throws Exception {
    ArrayList<File> files=transcriptDays().get(day);if(files==null||files.isEmpty())throw new IOException("这一天没有可用的转写文本");files=new ArrayList<>(files);Collections.reverse(files);
    boolean local=localSummaryModel().isFile();JSONObject provider=local?null:enabledLlmProvider();if(!local&&provider==null)throw new IOException("本地摘要模型未安装");double load=0;if(local){state("● LOADING QWEN");load=NativeAsr.load(new File(base,"models").toString(),"summary",4);}ArrayList<String> notes=new ArrayList<>(),facts=new ArrayList<>(),questions=new ArrayList<>();JSONArray sources=new JSONArray();ByteArrayOutputStream fingerprint=new ByteArrayOutputStream();
    LinkedHashSet<String> uniqueTexts=new LinkedHashSet<>();int index=1;for(File f:files){JSONObject j=readJson(f);String words=j.optString("text").trim();if(words.isEmpty())continue;String time=j.optString("created_at");if(time.length()>=16)time=time.substring(11,16);else time=when(f.lastModified());String audio=j.optString("audio_file",f.getName());boolean noise=words.matches("(?i)^\\s*(\\[blank_audio\\]|blank_audio|<blank>|just)\\s*[.!。！]?$"),included=!noise,unique=included&&uniqueTexts.add(words),question=isQuestionLike(words);String prefix=question?"[未回答的问题 "+time+"] 原文：“":"[语音转写原文 "+time+"] “";if(unique){(question?questions:facts).add("["+time+"] "+words.replace('\n',' '));for(int at=0;at<words.length();at+=650){int end=Math.min(words.length(),at+650);notes.add((at==0?prefix:"["+time+" 续] “")+words.substring(at,end)+"”");}}sources.put(new JSONObject().put("transcript_id",j.optString("transcript_id",f.getName())).put("audio_file",audio).put("time",time).put("excerpt",words.length()>90?words.substring(0,90)+"…":words).put("included",included).put("duplicate",included&&!unique).put("question",question));fingerprint.write(Files.readAllBytes(f.toPath()));index++;}
    if(notes.isEmpty())throw new IOException("当天转写文本均为空，无法生成摘要");state("● SUMMARIZING");
    while(totalChars(notes)>900){ArrayList<String> reduced=new ArrayList<>();for(String group:packNotes(notes,800)){String prompt="逐条阅读下面的语音记录，合并重复内容，但必须保留每个不同主题、原话中的模型名称、时间、数字、决定和待办。问句只能记为‘询问了……’，不能把问题当成已确认事实。忽略空白音频和无意义单词。只输出事实要点，最多 8 条：\n\n"+group;reduced.add(generateSummaryText(prompt,220,local,provider));}if(reduced.size()>=notes.size()&&totalChars(reduced)>=totalChars(notes))throw new IOException("摘要模型未能压缩长文本，请减少当天转写数量后重试");notes=reduced;}
    String material=joinNotes(notes);String prompt="逐条阅读全部当天语音记录后生成简体中文摘要。输入已标注为‘未回答的问题’或‘语音转写原文’。未回答问题中的任何说法都不是事实，不能写成‘使用了某模型’，只能在‘线索与风险’中写成‘用户询问当前使用什么模型，尚未回答’。普通转写也可能有识别错误；语义不通时必须写‘原文提到……，含义待确认’。避免元叙述，不统计记录数量，不提编号。严格只输出下面四个栏目并保留方括号。\n\n【今日概览】\n用 2–4 句自然概括已确认的测试和主题；未回答问题只能说‘用户询问了……’。\n【关键事项】\n只列原文明说的测试、决定和可确认信息；不要放未回答问题。\n【待办与提醒】\n只列原文明确提出的行动或期限；没有就写“暂无明确待办”。\n【线索与风险】\n逐项列出未回答问题、含义不清或需要确认的原文；没有就写“暂无”。\n\n当天记录（按时间顺序，已去除空白与重复）：\n"+material;
    String summary=generateSummaryText(prompt,380,local,provider);if(summary.trim().isEmpty())throw new IOException("摘要模型没有返回内容");String mode="abstractive";double coverage=factCoverage(summary,facts);if(local&&coverage<0.18){summary=extractiveSummary(facts,questions);mode="extractive_fallback";}String model=local?"Qwen3-0.6B":provider.optString("llmModel");String backend=local?"local":"lan_llm";JSONObject out=new JSONObject().put("kind","daily_summary").put("date",day).put("created_at",new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX",Locale.US).format(new Date())).put("model",model).put("backend",backend).put("summary_mode",mode).put("fact_coverage",coverage).put("transcript_count",sources.length()).put("source_hash",MemoCrypto.hex(MemoCrypto.sha(fingerprint.toByteArray()))).put("load_ms",load).put("content",summary).put("sources",sources);File target=dailySummaryFile(day);writeJson(target,out);log(out);return target;
  }
  int totalChars(Collection<String> values){int n=0;for(String s:values)n+=s.length();return n;}
  boolean isQuestionLike(String value){return value.matches("(?is).*(什么|是否|是不是|吗|么|为何|为什么|如何|怎么|谁|哪里|哪种|\\?).*");}
  double factCoverage(String summary,Collection<String> facts){if(facts.isEmpty())return 1;String out=summary.toLowerCase(Locale.ROOT).replaceAll("[\\s\\p{Punct}，。！？：；、“”‘’（）【】]","");double total=0;for(String fact:facts){String value=fact.replaceFirst("^\\[[^]]+\\]\\s*","").toLowerCase(Locale.ROOT).replaceAll("[\\s\\p{Punct}，。！？：；、“”‘’（）【】]","");int possible=Math.max(1,value.length()-1),hits=0;for(int i=0;i+2<=value.length();i++)if(out.contains(value.substring(i,i+2)))hits++;total+=hits/(double)possible;}return total/facts.size();}
  String extractiveSummary(ArrayList<String> facts,ArrayList<String> questions){StringBuilder out=new StringBuilder("【今日概览】\n");if(!facts.isEmpty())out.append("当天语音记录包含 ").append(facts.size()).append(" 项可回看的原文信息");if(!facts.isEmpty()&&!questions.isEmpty())out.append("，并有 ").append(questions.size()).append(" 个问题尚待确认");else if(facts.isEmpty()&&!questions.isEmpty())out.append("当天有 ").append(questions.size()).append(" 个问题尚待确认");out.append("。\n\n【关键事项】\n");if(facts.isEmpty())out.append("暂无可确认事项");else for(String value:facts)out.append("- 原文：").append(value).append('\n');out.append("\n【待办与提醒】\n暂无明确待办\n\n【线索与风险】\n");if(questions.isEmpty())out.append("暂无");else for(String value:questions)out.append("- 未回答问题：").append(value).append('\n');return out.toString().trim();}
  String joinNotes(Collection<String> values){StringBuilder out=new StringBuilder();for(String s:values){if(out.length()>0)out.append("\n\n");out.append(s);}return out.toString();}
  ArrayList<String> packNotes(ArrayList<String> values,int max){ArrayList<String> groups=new ArrayList<>();StringBuilder group=new StringBuilder();for(String value:values){if(group.length()>0&&group.length()+value.length()+2>max){groups.add(group.toString());group.setLength(0);}if(group.length()>0)group.append("\n\n");group.append(value);}if(group.length()>0)groups.add(group.toString());return groups;}
  String generateSummaryText(String prompt,int maxTokens,boolean local,JSONObject provider)throws Exception {return cleanGenerated(local?NativeAsr.generate(prompt,maxTokens):generateWithLlmProvider(prompt,maxTokens,provider));}
  String generateWithLlmProvider(String prompt,int maxTokens,JSONObject provider)throws Exception {String endpoint=provider.getString("llmEndpoint"),model=provider.getString("llmModel"),key=provider.optString("llmApiKey","");validateProviderUrl(endpoint);java.net.HttpURLConnection conn=(java.net.HttpURLConnection)new java.net.URL(endpoint).openConnection();conn.setConnectTimeout(15000);conn.setReadTimeout(120000);conn.setInstanceFollowRedirects(false);conn.setRequestMethod("POST");conn.setDoOutput(true);conn.setRequestProperty("Content-Type","application/json; charset=utf-8");if(!key.isEmpty())conn.setRequestProperty("Authorization","Bearer "+key);JSONObject body=new JSONObject().put("model",model).put("stream",false).put("temperature",0.2).put("max_tokens",maxTokens).put("chat_template_kwargs",new JSONObject().put("enable_thinking",false)).put("messages",new JSONArray().put(new JSONObject().put("role","system").put("content","你是语音备忘录摘要助手，只依据提供的记录回答，不补充未出现的事实。使用简体中文。" )).put(new JSONObject().put("role","user").put("content",prompt)));try(OutputStream out=conn.getOutputStream()){out.write(body.toString().getBytes(StandardCharsets.UTF_8));}int code=conn.getResponseCode();InputStream stream=code>=200&&code<300?conn.getInputStream():conn.getErrorStream();String response;try(BufferedReader reader=new BufferedReader(new InputStreamReader(stream==null?new ByteArrayInputStream(new byte[0]):stream,StandardCharsets.UTF_8))){StringBuilder b=new StringBuilder();for(String line;(line=reader.readLine())!=null;)b.append(line);response=b.toString();}finally{conn.disconnect();}if(code<200||code>=300)throw new IOException("局域网 LLM 返回 HTTP "+code+"："+(response.length()>240?response.substring(0,240):response));JSONObject json=new JSONObject(response);JSONArray choices=json.optJSONArray("choices");if(choices==null||choices.length()==0)throw new IOException("局域网 LLM 响应缺少 choices");return choices.getJSONObject(0).getJSONObject("message").optString("content");}
  String cleanGenerated(String value){return value.replaceAll("(?s)<think>.*?</think>","").replace("<|im_end|>","").replace("<|endoftext|>","").trim();}
  void showDailySummary(File f){
    try{JSONObject j=readJson(f);screen("每日摘要",this::showDailySummaries);LinearLayout hero=new LinearLayout(this);hero.setOrientation(LinearLayout.VERTICAL);hero.setPadding(dp(18),dp(17),dp(18),dp(17));hero.setBackground(bg(PRESSED,12));TextView date=text(displaySummaryDate(j.optString("date")),22,FG);date.setTypeface(Typeface.create("sans",Typeface.BOLD));hero.addView(date);String engine=j.optString("model","未知模型")+(j.optString("backend").equals("lan_llm")?" · 局域网测试":" · 本地")+(j.optString("summary_mode").equals("extractive_fallback")?" · 原文校验":"");TextView meta=mono(j.optInt("transcript_count")+" 条转写 · "+engine+" · "+when(f.lastModified()),12,DIM);meta.setPadding(0,dp(7),0,0);hero.addView(meta);LinearLayout.LayoutParams hp=new LinearLayout.LayoutParams(-1,-2);hp.setMargins(0,0,0,dp(12));list.addView(hero,hp);renderSummarySections(j.optString("content"));TextView sourceTitle=text("来源记录",15,ACCENT);sourceTitle.setTypeface(Typeface.create("sans",Typeface.BOLD));sourceTitle.setPadding(dp(5),dp(10),0,dp(8));list.addView(sourceTitle);JSONArray sources=j.optJSONArray("sources");if(sources!=null)for(int i=0;i<sources.length();i++){JSONObject s=sources.getJSONObject(i);row(s.optString("time")+"  "+s.optString("audio_file"),s.optString("excerpt"),null);}row("重新生成摘要","重新读取该日全部转写并覆盖当前摘要",()->startDailySummary(j.optString("date")));row("删除这份摘要","不会删除录音或转写文本",()->new AlertDialog.Builder(this).setTitle("删除这份每日摘要？").setNegativeButton("取消",null).setPositiveButton("删除",(d,w)->{if(f.delete())showDailySummaries();}).show());}catch(Exception e){error(e);}
  }
  void renderSummarySections(String value){String[] names={"今日概览","关键事项","待办与提醒","线索与风险"};boolean found=false;for(int i=0;i<names.length;i++){String marker="【"+names[i]+"】";int start=value.indexOf(marker);if(start<0)continue;found=true;start+=marker.length();int end=value.length();for(int k=i+1;k<names.length;k++){int next=value.indexOf("【"+names[k]+"】",start);if(next>=0){end=next;break;}}summaryCard(names[i],value.substring(start,end).trim());}if(!found)summaryCard("摘要",value.trim());}
  void summaryCard(String title,String body){LinearLayout card=new LinearLayout(this);card.setOrientation(LinearLayout.VERTICAL);card.setPadding(dp(15),dp(14),dp(15),dp(15));card.setBackground(bg(TITLE,10));TextView heading=text(title,16,ACCENT);heading.setTypeface(Typeface.create("sans",Typeface.BOLD));card.addView(heading);TextView copy=text(body.isEmpty()?"暂无":body,15,FG);copy.setTextIsSelectable(true);copy.setPadding(0,dp(9),0,0);card.addView(copy);LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,-2);p.setMargins(0,0,0,dp(9));list.addView(card,p);}

  void showWallet(){
    screen("钱包与二维码",this::showHome);JSONObject pair=null;try{pair=MemoCrypto.paired(this);}catch(Exception ignored){}
    if(pair==null){boolean stale=false;try{stale=MemoCrypto.hasStalePairing(this);}catch(Exception ignored){}note(stale?"合约已经升级，旧配对凭据的签名域不再匹配。请用当前版本重新生成并导入配对凭据，避免产生无法恢复的新记录。":"尚未配对钱包。真实存证需要先导入由钱包签名生成的配对凭据；应用不会要求助记词或私钥。");
      row("生成钱包配对二维码","使用另一台联网且装有 imToken 的手机扫码",this::showPairingQr);
      row("扫描签名数据二维码","imToken 完成两次签名后，用本设备摄像头扫描",this::startPairingCredentialScan);
      EditText credential=new EditText(this);credential.setHint("粘贴配对凭据");credential.setTextColor(FG);credential.setHintTextColor(DIM);credential.setBackgroundTintList(android.content.res.ColorStateList.valueOf(ACCENT));credential.setTypeface(Typeface.MONOSPACE);list.addView(credential,new LinearLayout.LayoutParams(-1,dp(96)));
      row("手动导入配对凭据","扫码不可用时粘贴；凭据由 Android Keystore 加密保存",()->{String value=credential.getText().toString().trim();task(()->{MemoCrypto.importCredential(this,extractCredential(value));main.post(this::showWallet);});});
    }else{String owner=pair.optString("owner");LinearLayout paired=row("已配对钱包",owner,null);paired.setLongClickable(true);paired.setOnLongClickListener(v->{v.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS);confirmClearPairing(owner);return true;});
      row("恢复链上记录","用原配对钱包签名一次，查询并在网页本地解密",()->showRecoveryQr(owner));}
    row("加密与二维码自检","固定测试密钥，仅验证实现，不可用于真实存证",()->task(()->{JSONObject j=cryptoTest();String report=j.toString(2);main.post(()->showInfo("加密自检",report,this::showWallet));}));
    note("签名与上链说明\n\n并非任意 imToken 钱包都可以。二维码载荷绑定上方配对地址；扫码后必须切换到同一地址签名并广播 Base Sepolia 交易。其他地址会被网页拒绝。恢复历史密文也需要原配对钱包再次签名派生密钥。设备不会持有钱包私钥，也不会自行广播交易。");
  }
  void confirmClearPairing(String owner){
    confirmSheet("更换配对钱包？","清除后可以重新配对其他钱包。已生成的历史密文仍绑定原钱包，只有原钱包才能恢复；录音和转写文本不会删除。","继续",ACCENT,()->confirmClearPairingAgain(owner));
  }
  void confirmClearPairingAgain(String owner){
    confirmSheet("最后确认","即将清除本机配对：\n"+owner+"\n\n此操作不会清除链上记录，也不会把旧记录迁移到新钱包。","清除配对",DANGER,()->{try{MemoCrypto.clearPairing(this);showInfo("配对已清除","现在可以生成新的配对二维码并导入其他钱包。录音和转写文本保持不变。",this::showWallet);}catch(Exception e){error(e);}});
  }
  void confirmSheet(String title,String message,String confirmLabel,int confirmColor,Runnable action){
    Dialog dialog=new Dialog(this);LinearLayout panel=new LinearLayout(this);panel.setOrientation(LinearLayout.VERTICAL);panel.setPadding(dp(22),dp(16),dp(22),dp(18));GradientDrawable panelBg=bg(TITLE,22);panelBg.setStroke(dp(1),DIM);panel.setBackground(panelBg);TextView handle=text("—",18,DIM);handle.setGravity(Gravity.CENTER);panel.addView(handle);TextView heading=text(title,21,FG);heading.setTypeface(Typeface.create("sans",Typeface.BOLD));heading.setPadding(0,dp(4),0,dp(12));panel.addView(heading);TextView body=text(message,14,DIM);body.setTextIsSelectable(false);panel.addView(body);
    LinearLayout actions=new LinearLayout(this);actions.setGravity(Gravity.RIGHT);actions.setPadding(0,dp(18),0,0);TextView cancel=pill("取消",false,DIM),confirm=pill(confirmLabel,true,confirmColor);LinearLayout.LayoutParams bp=new LinearLayout.LayoutParams(dp(138),dp(52));bp.setMargins(dp(6),0,0,0);actions.addView(cancel,bp);actions.addView(confirm,bp);panel.addView(actions);dialog.setContentView(panel);Window window=dialog.getWindow();if(window!=null){window.setBackgroundDrawableResource(android.R.color.transparent);window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);WindowManager.LayoutParams lp=window.getAttributes();lp.dimAmount=.72f;window.setAttributes(lp);}cancel.setOnClickListener(v->dialog.dismiss());confirm.setOnClickListener(v->{dialog.dismiss();action.run();});dialog.setOnShowListener(x->{Window w=dialog.getWindow();if(w!=null){w.setGravity(Gravity.BOTTOM);w.getDecorView().setPadding(dp(12),0,dp(12),dp(12));w.setLayout(-1,-2);}});dialog.show();
  }
  void showPairingQr(){
    try{
      JSONObject payload=new JSONObject().put("v",1).put("chainId",MEMO_CHAIN_ID).put("contract",MEMO_CONTRACT).put("keyScheme","wallet-signature-v1");
      String page=MEMO_PAGE+"#k="+MemoCrypto.b64(payload.toString().getBytes(StandardCharsets.UTF_8));
      String url="https://connect.token.im/link/navigate/DappView?url="+Uri.encode(page);Bitmap bitmap=qrBitmap(url);if(!qrRoundtrip(url))throw new IOException("配对二维码回读校验失败");
      screen("钱包签名配对",this::showWallet);ImageView image=new ImageView(this);image.setImageBitmap(bitmap);image.setAdjustViewBounds(true);image.setBackgroundColor(Color.WHITE);list.addView(image,new LinearLayout.LayoutParams(-1,-2));
      note("操作步骤\n\n1. 用另一台联网手机的 imToken 扫描二维码。\n2. 连接目标钱包，对同一份恢复声明签名两次。第一次派生密钥，第二次验证同一声明能否稳定产生相同密钥；否则未来可能无法恢复，所以立即拒绝配对。签名不广播、不消耗 gas。\n3. 页面显示“两次签名一致”后，会生成签名数据二维码。\n4. 回到本设备的钱包页，选择“扫描签名数据二维码”，用摄像头扫描。\n\n二维码包含解密密钥材料，只在两台设备面对面操作时短暂显示，请勿截图、转发或上传。");
    }catch(Exception e){error(e);}
  }
  void showRecoveryQr(String owner){
    try{
      JSONObject payload=new JSONObject().put("v",1).put("chainId",MEMO_CHAIN_ID).put("contract",MEMO_CONTRACT).put("owner",owner).put("keyScheme","wallet-signature-v1");
      String page=memoReadPage()+"#r="+MemoCrypto.b64(payload.toString().getBytes(StandardCharsets.UTF_8));
      String url="https://connect.token.im/link/navigate/DappView?url="+Uri.encode(page);Bitmap bitmap=qrBitmap(url);if(!qrRoundtrip(url))throw new IOException("恢复二维码回读校验失败");
      screen("恢复链上记录",this::showWallet);ImageView image=new ImageView(this);image.setImageBitmap(bitmap);image.setAdjustViewBounds(true);image.setBackgroundColor(Color.WHITE);list.addView(image,new LinearLayout.LayoutParams(-1,-2));
      note("操作步骤\n\n1. 用联网手机上的 imToken 扫描二维码。\n2. 切换到原配对地址 "+shortAddress(owner)+"。\n3. 对恢复声明签名一次；该签名不上链、不消耗 gas。\n4. 网页会查询该地址提交的记录，核对链上摘要并在浏览器本地解密。\n\n关闭网页后无需保留本页：以后可再次从“钱包与二维码 → 恢复链上记录”生成二维码。请勿向任何页面输入助记词或私钥。");
    }catch(Exception e){error(e);}
  }
  void startPairingCredentialScan(){
    if(checkSelfPermission(Manifest.permission.CAMERA)!=PackageManager.PERMISSION_GRANTED){requestPermissions(new String[]{Manifest.permission.CAMERA},REQUEST_CAMERA_PERMISSION);return;}
    screen("扫描配对二维码",this::showWallet);note("请在联网手机完成两次签名，等页面显示配对凭据二维码后再扫描。");QrScannerView scanner=new QrScannerView(this,new QrScannerView.Listener(){public void onResult(String value){try{MemoCrypto.importCredential(MainActivity.this,extractCredential(value));showInfo("配对成功","签名数据二维码已验证，配对凭据已由 Android Keystore 加密保存。",MainActivity.this::showWallet);}catch(Exception e){error(new IOException("二维码中的配对凭据无效："+e.getMessage()));}}public void onError(Exception e){error(e);}});LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,dp(470));p.setMargins(0,dp(4),0,dp(12));list.addView(scanner,p);
  }
  @Override public void onRequestPermissionsResult(int request,String[] permissions,int[] grants){super.onRequestPermissionsResult(request,permissions,grants);if(request==REQUEST_CAMERA_PERMISSION&&grants.length>0&&grants[0]==PackageManager.PERMISSION_GRANTED)startPairingCredentialScan();}
  String extractCredential(String value)throws Exception {
    String v=value==null?"":value.trim();if(v.startsWith("{")){JSONObject j=new JSONObject(v);v=j.optString("credential",j.optString("pairing",v));}
    if(v.contains("?")){Uri u=Uri.parse(v);String q=u.getQueryParameter("credential");if(q!=null&&!q.isEmpty())v=q;}
    int hash=v.indexOf('#');if(hash>=0){String fragment=v.substring(hash+1);for(String item:fragment.split("&")){String[] p=item.split("=",2);if(p.length==2&&(p[0].equals("credential")||p[0].equals("pairing")))v=Uri.decode(p[1]);}}
    if(v.startsWith("private-memo://pair/"))v=Uri.decode(v.substring("private-memo://pair/".length()));return v.trim();
  }
  String networkSummary(){ConnectivityManager cm=getSystemService(ConnectivityManager.class);Network n=cm.getActiveNetwork();if(n==null)return "未连接 · 点击打开 Wi-Fi 设置";NetworkCapabilities c=cm.getNetworkCapabilities(n);return c!=null&&c.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)?"Wi-Fi 已连接":"已有网络 · 点击管理 Wi-Fi";}
  void openWifiSettings(){try{startActivity(new Intent(Build.VERSION.SDK_INT>=29?Settings.Panel.ACTION_WIFI:Settings.ACTION_WIFI_SETTINGS));}catch(Exception e){startActivity(new Intent(Settings.ACTION_WIRELESS_SETTINGS));}}
  EditText settingField(String label,String value,boolean secret){TextView l=text(label,12,DIM);l.setPadding(dp(4),dp(12),dp(4),dp(5));list.addView(l);EditText e=new EditText(this);e.setText(value);e.setSingleLine(true);e.setTextColor(FG);e.setHintTextColor(DIM);e.setTextSize(14);e.setPadding(dp(12),dp(10),dp(12),dp(10));GradientDrawable g=bg(TITLE,8);g.setStroke(dp(1),Color.rgb(63,78,58));e.setBackground(g);if(secret)e.setInputType(android.text.InputType.TYPE_CLASS_TEXT|android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD);list.addView(e,new LinearLayout.LayoutParams(-1,dp(52)));return e;}
  JSONObject lanProviderPreset()throws Exception {return new JSONObject().put("enabled",false).put("type","lan_whisper").put("endpoint","http://192.168.10.191:9001/inference").put("model","whisper-1").put("language","auto").put("simplifiedChinese",true).put("apiKey","").put("llmEndpoint","http://192.168.10.191:9000/v1/chat/completions").put("llmModel","Qwen3-30B").put("llmApiKey",DEFAULT_LLM_BEARER);}
  JSONObject providerOrPreset()throws Exception {JSONObject p=MemoCrypto.provider(this);return p==null?lanProviderPreset():p;}
  void setProviderEnabled(boolean enabled){try{JSONObject p=providerOrPreset();if(enabled)validateProviderUrl(p.getString("endpoint"));p.put("enabled",enabled);MemoCrypto.saveProvider(this,p);showProviderSettings();}catch(Exception e){error(e);}}
  void applyLanProviderPreset(){try{JSONObject old=MemoCrypto.provider(this),p=lanProviderPreset();p.put("enabled",old!=null&&old.optBoolean("enabled"));MemoCrypto.saveProvider(this,p);showProviderConfig();}catch(Exception e){error(e);}}
  void showProviderSettings(){
    screen("联网语音转写",this::showSettings);boolean enabled=false;try{enabled=providerOrPreset().optBoolean("enabled");}catch(Exception ignored){}final boolean current=enabled;
    LinearLayout panel=new LinearLayout(this);panel.setGravity(Gravity.CENTER_VERTICAL);panel.setPadding(dp(16),dp(16),dp(14),dp(16));panel.setBackground(bg(current?PRESSED:TITLE,12));LinearLayout labels=new LinearLayout(this);labels.setOrientation(LinearLayout.VERTICAL);TextView title=text(current?"联网转写已开启":"联网转写已关闭",18,FG);title.setTypeface(Typeface.create("sans",Typeface.BOLD));labels.addView(title);TextView detail=text(current?"录音可发送到已配置的语音服务":"所有新转写只使用设备内置模型",13,DIM);detail.setPadding(0,dp(5),0,0);labels.addView(detail);panel.addView(labels,new LinearLayout.LayoutParams(0,-2,1));Switch toggle=new Switch(this);toggle.setChecked(current);toggle.setShowText(false);toggle.setThumbTintList(android.content.res.ColorStateList.valueOf(current?ACCENT:DIM));panel.addView(toggle,new LinearLayout.LayoutParams(dp(78),dp(58)));LinearLayout.LayoutParams pp=new LinearLayout.LayoutParams(-1,-2);pp.setMargins(0,0,0,dp(12));list.addView(panel,pp);toggle.setOnCheckedChangeListener((button,checked)->setProviderEnabled(checked));panel.setOnClickListener(v->toggle.setChecked(!toggle.isChecked()));
    note(current?"只有主动点击“转写为文本”时才会发送该条录音。关闭开关后立即恢复为内置模型。":"当前不会调用任何语音 Provider，录音和新转写均留在设备本机。");
    row("Provider 配置","地址、模型、语言与凭据 · 关闭状态下也可编辑",this::showProviderConfig);
  }
  void showProviderConfig(){
    screen("Provider 配置",this::showProviderSettings);JSONObject saved;try{saved=providerOrPreset();}catch(Exception e){error(e);return;}String savedType=saved.optString("type","lan_whisper");final boolean enabled=saved.optBoolean("enabled");
    CheckBox lan=new CheckBox(this);lan.setText("局域网 Whisper 协议（file / language / response_format）");lan.setTextColor(FG);lan.setTextSize(14);lan.setButtonTintList(android.content.res.ColorStateList.valueOf(ACCENT));lan.setChecked(savedType.equals("lan_whisper"));lan.setPadding(dp(4),0,0,dp(4));list.addView(lan);
    row("恢复当前局域网预设","192.168.10.191:9001 · 自动识别 · 简体输出",this::applyLanProviderPreset);
    EditText endpoint=settingField("语音识别接口",saved.optString("endpoint",savedType.equals("lan_whisper")?"http://192.168.10.191:9001/inference":"https://api.openai.com/v1/audio/transcriptions"),false);EditText model=settingField("模型名称（OpenAI 兼容接口使用）",saved.optString("model","whisper-1"),false);EditText language=settingField("语言（auto / zh / en）",saved.optString("language","auto"),false);CheckBox simplified=new CheckBox(this);simplified.setText("中文输出转为简体中文");simplified.setTextColor(FG);simplified.setTextSize(14);simplified.setButtonTintList(android.content.res.ColorStateList.valueOf(ACCENT));simplified.setChecked(saved.optBoolean("simplifiedChinese",true));simplified.setPadding(dp(4),dp(8),0,dp(4));list.addView(simplified);EditText key=settingField("语音接口 API Key（可选）",saved.optString("apiKey",""),true);
    EditText llmEndpoint=settingField("本地 LLM 接口（可选）",saved.optString("llmEndpoint","http://192.168.10.191:9000/v1/chat/completions"),false);EditText llmModel=settingField("本地 LLM 模型（可选）",saved.optString("llmModel","Qwen3-30B"),false);EditText llmKey=settingField("本地 LLM Bearer Token（可编辑）",saved.optString("llmApiKey",DEFAULT_LLM_BEARER),true);
    CheckBox reveal=new CheckBox(this);reveal.setText("显示 API Key / Bearer Token");reveal.setTextColor(DIM);reveal.setTextSize(13);reveal.setButtonTintList(android.content.res.ColorStateList.valueOf(ACCENT));reveal.setPadding(dp(4),dp(8),0,dp(4));reveal.setOnCheckedChangeListener((button,checked)->{key.setTransformationMethod(checked?null:android.text.method.PasswordTransformationMethod.getInstance());llmKey.setTransformationMethod(checked?null:android.text.method.PasswordTransformationMethod.getInstance());key.setSelection(key.length());llmKey.setSelection(llmKey.length());});list.addView(reveal);
    row("保存配置","保存不会改变联网转写总开关",()->{try{String type=lan.isChecked()?"lan_whisper":"openai_audio",url=endpoint.getText().toString().trim(),m=model.getText().toString().trim(),lang=language.getText().toString().trim(),k=key.getText().toString().trim(),llmUrl=llmEndpoint.getText().toString().trim(),llmM=llmModel.getText().toString().trim(),llmK=llmKey.getText().toString().trim();validateProviderUrl(url);if(type.equals("openai_audio")&&m.isEmpty())throw new IOException("OpenAI 兼容接口需要模型名称");if(!llmUrl.isEmpty())validateProviderUrl(llmUrl);JSONObject p=new JSONObject().put("enabled",enabled).put("type",type).put("endpoint",url).put("model",m).put("language",lang.isEmpty()?"auto":lang).put("simplifiedChinese",simplified.isChecked()).put("apiKey",k).put("llmEndpoint",llmUrl).put("llmModel",llmM).put("llmApiKey",llmK);MemoCrypto.saveProvider(this,p);showProviderSettings();}catch(Exception e){error(e);}});
    note("配置仅保存在设置中。总开关关闭时，转写流程不会读取地址或凭据，也不会在新生成的本地转写文件中写入 Provider 信息。API Key 由 Android Keystore 加密保存。");
  }
  void validateProviderUrl(String value)throws Exception {java.net.URL u=new java.net.URL(value);String scheme=u.getProtocol(),host=u.getHost();if(scheme.equals("https"))return;if(!scheme.equals("http")||!isPrivateIpv4(host))throw new IOException("HTTP 只允许局域网私有 IPv4 地址；公网 Provider 必须使用 HTTPS");}
  boolean isPrivateIpv4(String host){if(host==null||!host.matches("[0-9]{1,3}(\\.[0-9]{1,3}){3}"))return false;String[] s=host.split("\\.");int[] n=new int[4];try{for(int i=0;i<4;i++){n[i]=Integer.parseInt(s[i]);if(n[i]>255)return false;}}catch(Exception e){return false;}return n[0]==10||n[0]==127||(n[0]==192&&n[1]==168)||(n[0]==172&&n[1]>=16&&n[1]<=31);}
  void showSettings(){
    screen("实验设置",this::showHome);row("Wi-Fi 与网络",networkSummary(),this::openWifiSettings);row("联网语音转写",providerToggleSummary(),this::showProviderSettings);row("内置识别模型",selected()+" · 点击切换",()->{modelIndex=(modelIndex+1)%MODELS.length;showSettings();});
    row("语音段识别（VAD）",useVad?"已开启 · 过滤静音":"已关闭 · 识别完整音频",()->{useVad=!useVad;showSettings();});
    row("每日自动摘要",autoDailySummary()?"已开启 · 新增转写后使用 "+summaryEngineLabel()+" 更新":"已关闭 · 可在首页手动生成",()->setAutoDailySummary(!autoDailySummary()));
    row("预加载模型",selected()+" · CPU 4 线程",()->task(()->{double ms=NativeAsr.load(new File(base,"models").toString(),selected(),4);main.post(()->showInfo("模型已加载",selected()+"\n"+fmt(ms)+" ms",this::showSettings));}));
    row("三模型对比实验","官方样本 · 每个模型 3 轮",()->runBenchmark("ui-"+System.currentTimeMillis(),MODELS,new String[]{"r2t2-official.wav"},3,4,false));
    note("实验边界：本机验证 arm64 CPU、内存、录音、离线推理和加密链路；不等同于 RK3576 的 NPU、驱动、功耗和散热结果。");
  }
  void showInfo(String title,String value,Runnable back){screen(title,back);output(value);}
  void error(Throwable e){main.post(()->showInfo("操作失败",e.getMessage()==null?e.toString():e.getMessage(),this::showHome));}

  interface Work{void run()throws Exception;}
  void task(Work work){if(busy){state("BUSY");return;}busy=true;worker.execute(()->{try{state("● WORKING");work.run();state("● READY");}catch(Throwable e){try{log(new JSONObject().put("kind","error").put("error",e.toString()));}catch(Exception ignored){}error(e);state("● ERROR");}finally{busy=false;}});}
  synchronized void log(JSONObject j)throws Exception{
    j.put("recorded_at",new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX",Locale.US).format(new Date())).put("device",Build.MODEL).put("android_api",Build.VERSION.SDK_INT);
    try(FileOutputStream f=new FileOutputStream(new File(results,"events.jsonl"),true)){f.write((j.toString()+"\n").getBytes(StandardCharsets.UTF_8));}
  }
  JSONObject environment()throws Exception{
    ActivityManager.MemoryInfo mi=new ActivityManager.MemoryInfo();getSystemService(ActivityManager.class).getMemoryInfo(mi);ConnectivityManager cm=getSystemService(ConnectivityManager.class);
    return new JSONObject().put("manufacturer",Build.MANUFACTURER).put("model",Build.MODEL).put("soc",Build.SOC_MODEL).put("android",Build.VERSION.RELEASE).put("abi",new JSONArray(Arrays.asList(Build.SUPPORTED_ABIS))).put("total_mem_bytes",mi.totalMem).put("available_mem_bytes",mi.availMem).put("airplane_mode",Settings.Global.getInt(getContentResolver(),Settings.Global.AIRPLANE_MODE_ON,-1)).put("active_network",cm.getActiveNetwork()!=null).put("internet_permission",checkSelfPermission("android.permission.INTERNET")==PackageManager.PERMISSION_GRANTED);
  }
  JSONObject memory()throws Exception{
    Debug.MemoryInfo m=new Debug.MemoryInfo();Debug.getMemoryInfo(m);Intent battery=registerReceiver(null,new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
    JSONObject j=new JSONObject().put("pss_kb",m.getTotalPss()).put("native_heap_bytes",Debug.getNativeHeapAllocatedSize()).put("thermal_status",getSystemService(PowerManager.class).getCurrentThermalStatus());
    if(battery!=null)j.put("battery_temp_c",battery.getIntExtra(BatteryManager.EXTRA_TEMPERATURE,0)/10.0).put("battery_level",battery.getIntExtra(BatteryManager.EXTRA_LEVEL,-1));return j;
  }
  JSONObject transcribe(File wav,String name,int threads,boolean vad)throws Exception{
    float[] pcm=Wav.read(wav);double seconds=pcm.length/16000.0,load=NativeAsr.load(new File(base,"models").toString(),name,threads);long wall=SystemClock.elapsedRealtimeNanos(),cpu=android.os.Process.getElapsedCpuTime();
    int[] ranges;String segmentation;
    if(vad){ranges=NativeAsr.segments(new File(base,"models/silero_vad.onnx").toString(),pcm);segmentation="vad_max_15s";}
    else if(pcm.length>15*16000){int chunks=(pcm.length+15*16000-1)/(15*16000);ranges=new int[chunks*2];for(int i=0;i<chunks;i++){ranges[i*2]=i*15*16000;ranges[i*2+1]=Math.min(15*16000,pcm.length-ranges[i*2]);}segmentation="fixed_15s";}
    else{ranges=new int[]{0,pcm.length};segmentation="single";}
    StringBuilder words=new StringBuilder();JSONArray segs=new JSONArray();
    for(int i=0;i<ranges.length;i+=2){int a=Math.max(0,ranges[i]),z=Math.min(pcm.length,a+ranges[i+1]);if(z<=a)continue;String t=NativeAsr.transcribe(Arrays.copyOfRange(pcm,a,z)).trim();if(vad&&t.length()>=6){int max=0;Map<Character,Integer> counts=new HashMap<>();for(char c:t.toCharArray())max=Math.max(max,counts.merge(c,1,Integer::sum));if(max>t.length()*.5)t="";}if(!t.isEmpty()){if(words.length()>0)words.append("\n");words.append(t);}segs.put(new JSONObject().put("start_s",a/16000.0).put("duration_s",(z-a)/16000.0).put("text",t));}
    double infer=(SystemClock.elapsedRealtimeNanos()-wall)/1e6;
    return new JSONObject().put("kind","asr").put("model",name).put("backend","cpu").put("threads",threads).put("sample",wav.getName()).put("audio_sha256",MemoCrypto.hex(MemoCrypto.sha(Files.readAllBytes(wav.toPath())))).put("audio_seconds",seconds).put("load_ms",load).put("inference_ms",infer).put("cpu_ms",android.os.Process.getElapsedCpuTime()-cpu).put("rtf",infer/1000/seconds).put("vad",vad).put("segmentation",segmentation).put("text",words.toString()).put("segments",segs).put("memory_after",memory()).put("environment",environment());
  }
  JSONObject transcribeWithProvider(File wav,JSONObject provider)throws Exception {
    String endpoint=provider.getString("endpoint"),type=provider.optString("type","openai_audio"),model=provider.optString("model","whisper-1"),language=provider.optString("language","auto"),key=provider.optString("apiKey","");validateProviderUrl(endpoint);if(model.contains("\r")||model.contains("\n")||language.contains("\r")||language.contains("\n"))throw new IOException("Provider 参数不合法");
    java.net.URL providerUrl=new java.net.URL(endpoint);java.net.HttpURLConnection conn=(java.net.HttpURLConnection)providerUrl.openConnection();String boundary="----PrivateMemo"+System.currentTimeMillis();conn.setConnectTimeout(15000);conn.setReadTimeout(120000);conn.setInstanceFollowRedirects(false);conn.setRequestMethod("POST");conn.setDoOutput(true);conn.setChunkedStreamingMode(64*1024);if(!key.isEmpty())conn.setRequestProperty("Authorization","Bearer "+key);conn.setRequestProperty("Content-Type","multipart/form-data; boundary="+boundary);
    long start=SystemClock.elapsedRealtimeNanos();try(DataOutputStream out=new DataOutputStream(new BufferedOutputStream(conn.getOutputStream()))){String nl="\r\n";if(type.equals("lan_whisper")){writeMultipartField(out,boundary,"language",language);writeMultipartField(out,boundary,"response_format","json");}else writeMultipartField(out,boundary,"model",model);out.writeBytes("--"+boundary+nl+"Content-Disposition: form-data; name=\"file\"; filename=\"recording.wav\""+nl+"Content-Type: audio/wav"+nl+nl);try(InputStream in=new FileInputStream(wav)){byte[] buffer=new byte[64*1024];for(int n;(n=in.read(buffer))!=-1;)out.write(buffer,0,n);}out.writeBytes(nl+"--"+boundary+"--"+nl);}
    int code=conn.getResponseCode();InputStream stream=code>=200&&code<300?conn.getInputStream():conn.getErrorStream();String response;try(BufferedReader reader=new BufferedReader(new InputStreamReader(stream==null?new ByteArrayInputStream(new byte[0]):stream,StandardCharsets.UTF_8))){StringBuilder b=new StringBuilder();for(String line;(line=reader.readLine())!=null;)b.append(line);response=b.toString();}finally{conn.disconnect();}if(code<200||code>=300)throw new IOException("Provider 返回 HTTP "+code+"："+(response.length()>240?response.substring(0,240):response));JSONObject body=new JSONObject(response);String transcript=body.optString("text");if(transcript.trim().isEmpty())throw new IOException("Provider 响应中没有 text 字段");boolean normalize=provider.optBoolean("simplifiedChinese",true);if(normalize)transcript=toSimplifiedChinese(transcript);double ms=(SystemClock.elapsedRealtimeNanos()-start)/1e6;
    return new JSONObject().put("kind","asr").put("model",type.equals("lan_whisper")?"whisper-lan":model).put("backend",type).put("provider_host",providerUrl.getHost()).put("sample",wav.getName()).put("audio_sha256",MemoCrypto.hex(MemoCrypto.sha(Files.readAllBytes(wav.toPath())))).put("audio_seconds",Wav.read(wav).length/16000.0).put("inference_ms",ms).put("text_script",normalize?"zh-Hans":"provider-original").put("text",transcript).put("segments",new JSONArray()).put("environment",environment());
  }
  String toSimplifiedChinese(String value)throws Exception {try{return android.icu.text.Transliterator.getInstance("Traditional-Simplified").transliterate(value);}catch(Throwable e){throw new IOException("简体中文转换不可用",e);}}
  void writeMultipartField(DataOutputStream out,String boundary,String name,String value)throws Exception {String nl="\r\n";out.writeBytes("--"+boundary+nl+"Content-Disposition: form-data; name=\""+name+"\""+nl+nl+value+nl);}
  void runBenchmark(String id,String[] names,String[] samples,int rounds,int threads,boolean vad){task(()->{JSONObject report=new JSONObject().put("run_id",id).put("kind","benchmark").put("environment",environment()).put("status","running");JSONArray entries=new JSONArray();writeJson(new File(results,"latest-run.json"),report);int failures=0;for(String name:names){NativeAsr.release();for(String sample:samples)for(int r=0;r<rounds;r++){try{state(name.toUpperCase()+" "+(r+1)+"/"+rounds);JSONObject j=transcribe(new File(base,"samples/"+new File(sample).getName()),name,threads,vad);j.put("round",r+1).put("run_id",id);entries.put(j);log(j);}catch(Throwable e){failures++;entries.put(new JSONObject().put("model",name).put("error",e.toString()));NativeAsr.release();}}}report.put("entries",entries).put("status",failures==0?"complete":"failed").put("failures",failures);writeJson(new File(results,id+".json"),report);writeJson(new File(results,"latest-run.json"),report);log(report);main.post(()->showInfo("实验完成",report.optString("status")+"\n结果已保存到 results/",this::showSettings));});}
  void writeJson(File f,JSONObject j)throws Exception{Files.write(f.toPath(),j.toString(2).getBytes(StandardCharsets.UTF_8));}
  JSONObject readJson(File f)throws Exception{return new JSONObject(new String(Files.readAllBytes(f.toPath()),StandardCharsets.UTF_8));}

  Bitmap qrBitmap(String value)throws Exception{
    Map<EncodeHintType,Object> hints=new EnumMap<>(EncodeHintType.class);hints.put(EncodeHintType.CHARACTER_SET,"UTF-8");hints.put(EncodeHintType.MARGIN,3);BitMatrix m=new MultiFormatWriter().encode(value,BarcodeFormat.QR_CODE,900,900,hints);int[] px=new int[m.getWidth()*m.getHeight()];for(int y=0;y<m.getHeight();y++)for(int x=0;x<m.getWidth();x++)px[y*m.getWidth()+x]=m.get(x,y)?Color.BLACK:Color.WHITE;return Bitmap.createBitmap(px,m.getWidth(),m.getHeight(),Bitmap.Config.ARGB_8888);
  }
  boolean qrRoundtrip(String value)throws Exception{Bitmap b=qrBitmap(value);int[] px=new int[b.getWidth()*b.getHeight()];b.getPixels(px,0,b.getWidth(),0,0,b.getWidth(),b.getHeight());Map<DecodeHintType,Object> hints=new EnumMap<>(DecodeHintType.class);hints.put(DecodeHintType.POSSIBLE_FORMATS,Collections.singletonList(BarcodeFormat.QR_CODE));hints.put(DecodeHintType.TRY_HARDER,Boolean.TRUE);hints.put(DecodeHintType.PURE_BARCODE,Boolean.TRUE);String decoded=new MultiFormatReader().decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(b.getWidth(),b.getHeight(),px))),hints).getText();return value.equals(decoded);}
  JSONObject cryptoTest()throws Exception{JSONObject j=MemoCrypto.selfTest();String link=MEMO_PAGE+"#test="+MemoCrypto.b64(j.getString("blob_hex").getBytes(StandardCharsets.UTF_8));j.put("qr_roundtrip",qrRoundtrip(link)).put("environment",environment());writeJson(new File(results,"crypto-self-test.json"),j);log(j);return j;}
  void createMemo(JSONObject transcript,File source)throws Exception{
    String words=transcript.optString("text");if(words.trim().isEmpty())throw new IOException("这条转写没有识别出文本，无法生成存证二维码");JSONObject pair=MemoCrypto.paired(this);if(pair==null)throw new IOException("尚未配对钱包。请先在“钱包与二维码”中导入配对凭据。");
    long ts=System.currentTimeMillis()/1000;byte[] nonce=new byte[12];new java.security.SecureRandom().nextBytes(nonce);byte[] blob=MemoCrypto.encrypt(words,MemoCrypto.unhex(pair.getString("kek")),ts,nonce);
    JSONObject rec=new JSONObject().put("t",ts).put("h","0x"+MemoCrypto.hex(MemoCrypto.sha(blob))).put("c","chain").put("b",MemoCrypto.hex(blob));JSONObject payload=new JSONObject().put("v",1).put("chainId",MEMO_CHAIN_ID).put("contract",MEMO_CONTRACT).put("owner",pair.getString("owner")).put("keyScheme","wallet-signature-v1").put("sourceTranscript",transcript.optString("transcript_id",source.getName())).put("records",new JSONArray().put(rec));
    String page=memoReadPage()+"#p="+MemoCrypto.b64(payload.toString().getBytes(StandardCharsets.UTF_8));String url="https://connect.token.im/link/navigate/DappView?url="+Uri.encode(page);Bitmap qr=qrBitmap(url);boolean scan=qrRoundtrip(url);try(FileOutputStream f=new FileOutputStream(new File(results,"latest-qr.png"))){qr.compress(Bitmap.CompressFormat.PNG,100,f);}JSONObject out=new JSONObject().put("kind","encrypted_memo").put("qr_roundtrip",scan).put("payload",payload).put("page_url",page).put("universal_link",url);writeJson(new File(results,"memo-"+ts+".json"),out);log(out);main.post(()->showQr(qr,pair.optString("owner"),source));
  }
  void showQr(Bitmap bitmap,String owner,File source){screen("签名上链",()->showTranscript(source));ImageView image=new ImageView(this);image.setImageBitmap(bitmap);image.setAdjustViewBounds(true);image.setBackgroundColor(Color.WHITE);list.addView(image,new LinearLayout.LayoutParams(-1,-2));note("用联网设备上的 imToken 扫码。\n\n必须使用配对地址 "+shortAddress(owner)+" 签名；其他钱包地址会被拒绝。目标网络：Base Sepolia。此手机保持离线，交易由钱包端确认并广播。");}

  void startRecording(int seconds){
    if(checkSelfPermission(Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED){requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO,Manifest.permission.POST_NOTIFICATIONS},7);error(new IOException("请授权麦克风后再次点击录音"));return;}
    if(AudioCaptureService.recording){showRecorder();return;}startForegroundService(new Intent(this,AudioCaptureService.class).putExtra("seconds",seconds));main.postDelayed(this::showRecorder,120);
  }
  void stopRecording(){state("● SAVING");startService(new Intent(this,AudioCaptureService.class).setAction("stop"));}
  File findLatestRecording(){File[] fs=sorted(recordings,".wav");return fs.length==0?null:fs[0];}
  void handleIntent(Intent i){
    String action=i.getStringExtra("action");if(action==null)return;i.removeExtra("action");
    if(action.equals("benchmark"))runBenchmark(i.getStringExtra("run_id")==null?"bench-"+System.currentTimeMillis():i.getStringExtra("run_id"),(i.getStringExtra("models")==null?"paraformer,sensevoice,r2t2":i.getStringExtra("models")).split(","),(i.getStringExtra("samples")==null?"r2t2-official.wav":i.getStringExtra("samples")).split(","),i.getIntExtra("rounds",3),i.getIntExtra("threads",4),i.getBooleanExtra("vad",false));
    else if(action.equals("crypto"))task(()->{JSONObject j=cryptoTest();String report=j.toString(2);main.post(()->showInfo("加密自检",report,this::showHome));});
    else if(action.equals("record"))startRecording(i.getIntExtra("seconds",8));
    else if(action.equals("configure-lan-provider"))applyLanProviderPreset();
    else if(action.equals("set-provider-enabled"))setProviderEnabled(i.getBooleanExtra("enabled",false));
    else if(action.equals("script-test"))task(()->{String input=i.getStringExtra("text");JSONObject j=new JSONObject().put("input",input).put("output",toSimplifiedChinese(input));writeJson(new File(results,"script-test.json"),j);main.post(()->showInfo("简体转换自检",j.optString("output"),this::showSettings));});
    else if(action.equals("record-transcribe")){File f=findLatestRecording();if(f!=null)task(()->{JSONObject provider=MemoCrypto.provider(this);JSONObject j=provider!=null&&provider.optBoolean("enabled")?transcribeWithProvider(f,provider):transcribe(f,i.getStringExtra("model")==null?"paraformer":i.getStringExtra("model"),4,true);File saved=saveTranscript(j,f);log(j);writeJson(new File(results,"recording-transcription.json"),j);main.post(()->showTranscript(saved));});}
    else if(action.equals("show-recordings"))showRecordings();else if(action.equals("show-transcripts"))showTranscripts();else if(action.equals("show-wallet"))showWallet();
  }
}
