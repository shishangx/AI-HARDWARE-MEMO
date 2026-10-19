package im.privatememo.lab;
import java.io.*;
import java.nio.*;
import java.nio.file.*;

public final class Wav {
  public static float[] read(File file) throws Exception {
    byte[] data=Files.readAllBytes(file.toPath());
    ByteBuffer b=ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN);
    if(data.length<44 || b.getInt(0)!=0x46464952 || b.getInt(8)!=0x45564157)throw new IOException("不是 RIFF WAV");
    int rate=0,channels=0,bits=0,format=0,offset=-1,length=0;
    for(int p=12;p+8<=data.length;) {
      int id=b.getInt(p), size=b.getInt(p+4);
      if(size<0 || p+8L+size>data.length)throw new IOException("WAV chunk 越界");
      if(id==0x20746d66 && size>=16) {format=b.getShort(p+8)&65535;channels=b.getShort(p+10)&65535;rate=b.getInt(p+12);bits=b.getShort(p+22)&65535;}
      if(id==0x61746164){offset=p+8;length=size;}
      p+=8+size+(size&1);
    }
    if(format!=1 || bits!=16 || rate<=0 || channels<1 || offset<0)throw new IOException("需要 16bit PCM WAV");
    int frames=length/(2*channels);float[] mono=new float[frames];
    for(int i=0;i<frames;i++)for(int c=0;c<channels;c++)mono[i]+=b.getShort(offset+(i*channels+c)*2)/(32768f*channels);
    if(rate==16000)return mono;
    float[] out=new float[(int)((long)frames*16000/rate)];
    for(int i=0;i<out.length;i++){double p=i*(double)rate/16000;int a=Math.min((int)p,frames-1),z=Math.min(a+1,frames-1);out[i]=(float)(mono[a]+(mono[z]-mono[a])*(p-a));}
    return out;
  }
  public static void wrapPcm(File pcm,File wav) throws Exception {
    byte[] data=Files.readAllBytes(pcm.toPath());ByteBuffer h=ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN);
    h.putInt(0x46464952).putInt(data.length+36).putInt(0x45564157).putInt(0x20746d66).putInt(16);
    h.putShort((short)1).putShort((short)1).putInt(16000).putInt(32000).putShort((short)2).putShort((short)16).putInt(0x61746164).putInt(data.length);
    try(FileOutputStream f=new FileOutputStream(wav)){f.write(h.array());f.write(data);}
  }
}
