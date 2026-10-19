package im.privatememo.lab;

import android.content.Context;
import android.graphics.*;
import android.os.SystemClock;
import android.view.View;

public class OrbitalView extends View {
  public static final int HOME=0, RECORDING=1, PAUSED=2;
  private final Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG);
  private int mode=HOME; private float progress=.45f;
  private final int accent=Color.rgb(134,198,92), dim=Color.rgb(54,66,50), coral=Color.rgb(235,130,110);
  public OrbitalView(Context c){super(c);setLayerType(View.LAYER_TYPE_SOFTWARE,null);}
  public void setMode(int value){mode=value;invalidate();}
  public void setProgress(float value){progress=Math.max(0,Math.min(1,value));invalidate();}
  @Override protected void onDraw(Canvas c){super.onDraw(c);float cx=getWidth()/2f,cy=getHeight()/2f,r=Math.min(getWidth(),getHeight())*.34f;
    paint.setStyle(Paint.Style.STROKE);paint.setStrokeWidth(dp(1));paint.setColor(Color.rgb(47,60,43));c.drawCircle(cx,cy,r+dp(20),paint);c.drawCircle(cx,cy,r-dp(8),paint);
    paint.setShadowLayer(dp(18),0,0,Color.argb(115,100,200,75));paint.setStrokeWidth(dp(mode==HOME?3:5));paint.setStrokeCap(Paint.Cap.ROUND);paint.setColor(accent);
    if(mode==HOME)c.drawArc(cx-r,cy-r,cx+r,cy+r,-88,352,false,paint);else{
      int bars=72;for(int i=0;i<bars;i++){float f=i/(float)bars,a=(float)(Math.PI*2*f-Math.PI/2);float inner=r-dp(8),outer=r+(i%3==0?dp(11):dp(7));paint.setColor(f<=progress?accent:dim);paint.setStrokeWidth(dp(3));c.drawLine(cx+(float)Math.cos(a)*inner,cy+(float)Math.sin(a)*inner,cx+(float)Math.cos(a)*outer,cy+(float)Math.sin(a)*outer,paint);}
    }
    paint.clearShadowLayer();paint.setStyle(Paint.Style.FILL);if(mode==HOME){paint.setColor(Color.rgb(207,232,196));c.drawRoundRect(cx-dp(42),cy-dp(42),cx+dp(42),cy+dp(42),dp(25),dp(25),paint);paint.setColor(Color.rgb(13,18,12));paint.setStyle(Paint.Style.STROKE);paint.setStrokeWidth(dp(6));c.drawArc(cx-dp(23),cy-dp(18),cx+dp(23),cy+dp(16),200,260,false,paint);c.drawCircle(cx-dp(17),cy+dp(14),dp(5),paint);}else{paint.setStyle(Paint.Style.FILL);paint.setColor(mode==PAUSED?Color.rgb(109,122,104):coral);c.drawCircle(cx,cy,dp(27),paint);}
    if(mode==RECORDING){postInvalidateDelayed(1000);}
  }
  int dp(int v){return Math.round(v*getResources().getDisplayMetrics().density);}
}
