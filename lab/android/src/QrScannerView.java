package im.privatememo.lab;

import android.annotation.SuppressLint;
import android.content.*;
import android.graphics.*;
import android.hardware.camera2.*;
import android.media.*;
import android.os.*;
import android.view.*;
import android.widget.*;
import com.google.zxing.*;
import com.google.zxing.common.HybridBinarizer;
import java.nio.ByteBuffer;
import java.util.*;

public final class QrScannerView extends FrameLayout implements TextureView.SurfaceTextureListener {
  public interface Listener { void onResult(String value); void onError(Exception error); }
  final TextureView preview; final Listener listener; HandlerThread thread; Handler handler; CameraDevice camera; CameraCaptureSession session; ImageReader reader; boolean finished;

  public QrScannerView(Context context,Listener result){super(context);listener=result;setBackgroundColor(Color.BLACK);preview=new TextureView(context);preview.setSurfaceTextureListener(this);addView(preview,new FrameLayout.LayoutParams(-1,-1));TextView guide=new TextView(context);guide.setText("将签名数据二维码放入框内");guide.setTextColor(Color.rgb(207,232,196));guide.setTextSize(15);guide.setGravity(Gravity.CENTER);guide.setBackgroundColor(0x990d120c);FrameLayout.LayoutParams gp=new FrameLayout.LayoutParams(-1,dp(52),Gravity.BOTTOM);gp.setMargins(dp(18),0,dp(18),dp(18));addView(guide,gp);}
  int dp(int n){return Math.round(n*getResources().getDisplayMetrics().density);}
  void startThread(){if(thread!=null)return;thread=new HandlerThread("pairing-qr-camera");thread.start();handler=new Handler(thread.getLooper());}
  @SuppressLint("MissingPermission") void open(){try{startThread();CameraManager manager=(CameraManager)getContext().getSystemService(Context.CAMERA_SERVICE);String chosen=null;for(String id:manager.getCameraIdList()){Integer facing=manager.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING);if(facing!=null&&facing==CameraCharacteristics.LENS_FACING_BACK){chosen=id;break;}}if(chosen==null&&manager.getCameraIdList().length>0)chosen=manager.getCameraIdList()[0];if(chosen==null)throw new CameraAccessException(CameraAccessException.CAMERA_ERROR,"找不到摄像头");manager.openCamera(chosen,new CameraDevice.StateCallback(){public void onOpened(CameraDevice c){camera=c;createSession();}public void onDisconnected(CameraDevice c){c.close();camera=null;}public void onError(CameraDevice c,int e){c.close();camera=null;fail(new Exception("摄像头错误 "+e));}},handler);}catch(Exception e){fail(e);}}
  void createSession(){try{SurfaceTexture texture=preview.getSurfaceTexture();if(texture==null)return;texture.setDefaultBufferSize(1280,720);Surface surface=new Surface(texture);reader=ImageReader.newInstance(1280,720,ImageFormat.YUV_420_888,2);reader.setOnImageAvailableListener(this::scan,handler);CaptureRequest.Builder request=camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);request.addTarget(surface);request.addTarget(reader.getSurface());request.set(CaptureRequest.CONTROL_AF_MODE,CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);request.set(CaptureRequest.CONTROL_AE_MODE,CaptureRequest.CONTROL_AE_MODE_ON);camera.createCaptureSession(Arrays.asList(surface,reader.getSurface()),new CameraCaptureSession.StateCallback(){public void onConfigured(CameraCaptureSession s){if(camera==null)return;session=s;try{s.setRepeatingRequest(request.build(),null,handler);}catch(Exception e){fail(e);}}public void onConfigureFailed(CameraCaptureSession s){fail(new Exception("无法启动二维码取景"));}},handler);}catch(Exception e){fail(e);}}
  void scan(ImageReader source){Image image=source.acquireLatestImage();if(image==null)return;try{if(finished)return;Image.Plane plane=image.getPlanes()[0];ByteBuffer buffer=plane.getBuffer();int width=image.getWidth(),height=image.getHeight(),rowStride=plane.getRowStride(),pixelStride=plane.getPixelStride();byte[] raw=new byte[buffer.remaining()];buffer.get(raw);byte[] y=new byte[width*height];for(int row=0;row<height;row++)for(int col=0;col<width;col++)y[row*width+col]=raw[row*rowStride+col*pixelStride];PlanarYUVLuminanceSource lum=new PlanarYUVLuminanceSource(y,width,height,0,0,width,height,false);Map<DecodeHintType,Object> hints=new EnumMap<>(DecodeHintType.class);hints.put(DecodeHintType.POSSIBLE_FORMATS,Collections.singletonList(BarcodeFormat.QR_CODE));hints.put(DecodeHintType.TRY_HARDER,Boolean.TRUE);Result result=new MultiFormatReader().decode(new BinaryBitmap(new HybridBinarizer(lum)),hints);finished=true;post(()->listener.onResult(result.getText()));}catch(NotFoundException ignored){}catch(Exception e){fail(e);}finally{image.close();}}
  void fail(Exception e){if(finished)return;finished=true;post(()->listener.onError(e));}
  public void stop(){try{if(session!=null)session.close();}catch(Exception ignored){}session=null;try{if(camera!=null)camera.close();}catch(Exception ignored){}camera=null;try{if(reader!=null)reader.close();}catch(Exception ignored){}reader=null;if(thread!=null){thread.quitSafely();thread=null;handler=null;}}
  @Override protected void onDetachedFromWindow(){stop();super.onDetachedFromWindow();}
  public void onSurfaceTextureAvailable(SurfaceTexture s,int w,int h){open();}public void onSurfaceTextureSizeChanged(SurfaceTexture s,int w,int h){}public boolean onSurfaceTextureDestroyed(SurfaceTexture s){stop();return true;}public void onSurfaceTextureUpdated(SurfaceTexture s){}
}
