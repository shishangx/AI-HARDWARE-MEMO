package im.privatememo.lab;
import android.app.*;
import android.content.*;
import android.media.*;
import android.os.*;
import java.io.*;
import java.text.SimpleDateFormat;
import java.util.*;

public class AudioCaptureService extends Service {
  public static final int MAX_SECONDS=300;
  public static volatile boolean recording=false,paused=false;
  public static volatile String error="";
  public static volatile File lastFile=null;
  public static volatile long startedAt=0,bytesWritten=0;
  private volatile boolean stopRequested=false;
  @Override public IBinder onBind(Intent i){return null;}
  public static long recordedMillis(){return bytesWritten*1000L/(16000L*2L);}
  static String timer(){long s=recordedMillis()/1000;return String.format(Locale.US,"%02d:%02d / 05:00",s/60,s%60);}

  @Override public int onStartCommand(Intent intent,int flags,int id){
    String action=intent==null?null:intent.getAction();
    if("stop".equals(action)){stopRequested=true;paused=false;updateNotification();return START_NOT_STICKY;}
    if("pause".equals(action)&&recording){paused=true;updateNotification();return START_NOT_STICKY;}
    if("resume".equals(action)&&recording){paused=false;updateNotification();return START_NOT_STICKY;}
    if(recording)return START_NOT_STICKY;
    getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel("record","离线录音",NotificationManager.IMPORTANCE_LOW));
    recording=true;paused=false;stopRequested=false;error="";startedAt=SystemClock.elapsedRealtime();bytesWritten=0;lastFile=null;
    startForeground(1,notification());
    int requested=intent==null?MAX_SECONDS:intent.getIntExtra("seconds",MAX_SECONDS);
    int maxSeconds=requested<=0?MAX_SECONDS:Math.min(requested,MAX_SECONDS);
    new Thread(()->capture(maxSeconds),"memo-audio").start();return START_NOT_STICKY;
  }
  Notification notification(){
    String action=paused?"resume":"pause",label=paused?"继续":"暂停";
    PendingIntent toggle=PendingIntent.getService(this,2,new Intent(this,AudioCaptureService.class).setAction(action),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
    PendingIntent stop=PendingIntent.getService(this,3,new Intent(this,AudioCaptureService.class).setAction("stop"),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
    return new Notification.Builder(this,"record").setContentTitle(paused?"Private Memo 录音已暂停":"Private Memo 正在录音")
      .setContentText(timer()+" · 最长 5 分钟 · 音频仅保存在本机").setSmallIcon(android.R.drawable.ic_btn_speak_now).setOngoing(true)
      .addAction(new Notification.Action.Builder(null,label,toggle).build()).addAction(new Notification.Action.Builder(null,"停止并保存",stop).build()).build();
  }
  void updateNotification(){if(recording)getSystemService(NotificationManager.class).notify(1,notification());}
  private void capture(int maxSeconds){
    AudioRecord r=null;File pcm=null;boolean active=false;
    try{
      File dir=new File(getExternalFilesDir(null),"recordings");dir.mkdirs();String stem="recording_"+new SimpleDateFormat("yyyy-MM-dd_HH-mm-ss",Locale.getDefault()).format(new Date());int suffix=2;while(new File(dir,stem+".wav").exists()||new File(dir,stem+".pcm").exists())stem="recording_"+new SimpleDateFormat("yyyy-MM-dd_HH-mm-ss",Locale.getDefault()).format(new Date())+"_"+(suffix++);pcm=new File(dir,stem+".pcm");
      int size=Math.max(6400,AudioRecord.getMinBufferSize(16000,AudioFormat.CHANNEL_IN_MONO,AudioFormat.ENCODING_PCM_16BIT));
      r=new AudioRecord(MediaRecorder.AudioSource.MIC,16000,AudioFormat.CHANNEL_IN_MONO,AudioFormat.ENCODING_PCM_16BIT,size);
      if(r.getState()!=AudioRecord.STATE_INITIALIZED)throw new IOException("AudioRecord 初始化失败");
      r.startRecording();active=true;byte[] b=new byte[3200];long limit=maxSeconds*16000L*2L,lastNotify=0;
      try(FileOutputStream f=new FileOutputStream(pcm)){
        while(!stopRequested&&bytesWritten<limit){
          if(paused){if(active){r.stop();active=false;}SystemClock.sleep(80);continue;}
          if(!active){r.startRecording();active=true;}
          int count=r.read(b,0,b.length);if(count<0)throw new IOException("录音读取失败 "+count);if(count>0){long left=limit-bytesWritten;int write=(int)Math.min(count,left);f.write(b,0,write);bytesWritten+=write;}
          long now=SystemClock.elapsedRealtime();if(now-lastNotify>=1000){updateNotification();lastNotify=now;}
        }
      }
      if(active){r.stop();active=false;}lastFile=new File(dir,stem+".wav");Wav.wrapPcm(pcm,lastFile);pcm.delete();
    }catch(Exception e){error=e.toString();}
    finally{try{if(active&&r!=null)r.stop();}catch(Exception ignored){}if(r!=null)r.release();recording=false;paused=false;stopForeground(STOP_FOREGROUND_REMOVE);stopSelf();}
  }
  @Override public void onDestroy(){stopRequested=true;paused=false;super.onDestroy();}
}
