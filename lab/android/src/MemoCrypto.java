package im.privatememo.lab;
import android.content.Context;
import android.security.keystore.*;
import android.util.Base64;
import org.json.*;
import javax.crypto.*;
import javax.crypto.spec.*;
import java.io.*;
import java.nio.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.util.*;

public final class MemoCrypto {
  static byte[] bytes(String s){return s.getBytes(StandardCharsets.UTF_8);}
  public static String hex(byte[] a){StringBuilder s=new StringBuilder();for(byte b:a)s.append(String.format(Locale.US,"%02x",b&255));return s.toString();}
  public static byte[] unhex(String x){x=x.replaceFirst("^0x","");if(x.length()%2!=0 || !x.matches("[0-9a-fA-F]+"))throw new IllegalArgumentException("非法十六进制");byte[] b=new byte[x.length()/2];for(int i=0;i<b.length;i++)b[i]=(byte)Integer.parseInt(x.substring(i*2,i*2+2),16);return b;}
  public static String b64(byte[] b){return Base64.encodeToString(b,Base64.URL_SAFE|Base64.NO_WRAP|Base64.NO_PADDING);}
  public static byte[] sha(byte[] b)throws Exception{return MessageDigest.getInstance("SHA-256").digest(b);}
  static byte[] hmac(byte[] k,byte[] v)throws Exception{Mac m=Mac.getInstance("HmacSHA256");m.init(new SecretKeySpec(k,"HmacSHA256"));return m.doFinal(v);}
  static byte[] join(byte[]... items)throws Exception{ByteArrayOutputStream b=new ByteArrayOutputStream();for(byte[] a:items)b.write(a);return b.toByteArray();}
  static byte[] ck(byte[] kek,long ts)throws Exception{return hmac(hmac(ByteBuffer.allocate(8).putLong(ts).array(),kek),join(bytes("vmemo/ck/v1"),new byte[]{1}));}
  static byte[] aad(long ts)throws Exception{return join(bytes("vmemo/v1"),ByteBuffer.allocate(8).putLong(ts).array());}
  public static byte[] encrypt(String text,byte[] kek,long ts,byte[] nonce)throws Exception {
    Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.ENCRYPT_MODE,new SecretKeySpec(ck(kek,ts),"AES"),new GCMParameterSpec(128,nonce));c.updateAAD(aad(ts));return join(new byte[]{3},nonce,c.doFinal(bytes(text)));
  }
  public static String decrypt(byte[] blob,byte[] kek,long ts)throws Exception {
    if(blob.length<29 || blob[0]!=3)throw new GeneralSecurityException("不支持的密文版本");
    Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.DECRYPT_MODE,new SecretKeySpec(ck(kek,ts),"AES"),new GCMParameterSpec(128,Arrays.copyOfRange(blob,1,13)));c.updateAAD(aad(ts));return new String(c.doFinal(Arrays.copyOfRange(blob,13,blob.length)),StandardCharsets.UTF_8);
  }
  static SecretKey wrappingKey()throws Exception {
    KeyStore k=KeyStore.getInstance("AndroidKeyStore");k.load(null);
    if(!k.containsAlias("private-memo-lab-wrap")) {
      KeyGenerator g=KeyGenerator.getInstance("AES","AndroidKeyStore");g.init(new KeyGenParameterSpec.Builder("private-memo-lab-wrap",KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build());g.generateKey();
    }
    return (SecretKey)k.getKey("private-memo-lab-wrap",null);
  }
  public static void importCredential(Context ctx,String encoded)throws Exception {
    JSONObject j=new JSONObject(new String(Base64.decode(encoded.trim(),Base64.URL_SAFE),StandardCharsets.UTF_8));
    if(j.optInt("v")!=2 || j.optInt("chainId")!=MainActivity.MEMO_CHAIN_ID || !j.optString("contract").equalsIgnoreCase(MainActivity.MEMO_CONTRACT))throw new GeneralSecurityException("配对凭据属于旧合约或其他网络，请用当前版本重新生成");
    if(!j.getString("scheme").equals("wallet-signature-v1") || !j.getString("owner").matches("0x[0-9a-fA-F]{40}") || unhex(j.getString("kek")).length!=32)throw new GeneralSecurityException("配对凭据格式不正确");
    writeWrapped(ctx,"pairing.wrapped",j);
  }
  static boolean currentCredential(JSONObject j){return j!=null&&j.optInt("v")==2&&j.optInt("chainId")==MainActivity.MEMO_CHAIN_ID&&j.optString("contract").equalsIgnoreCase(MainActivity.MEMO_CONTRACT);}
  public static JSONObject paired(Context ctx)throws Exception {
    File f=new File(ctx.getFilesDir(),"pairing.wrapped");if(!f.exists())return null;
    JSONObject j=readWrapped(ctx,"pairing.wrapped");return currentCredential(j)?j:null;
  }
  public static boolean hasStalePairing(Context ctx)throws Exception {File f=new File(ctx.getFilesDir(),"pairing.wrapped");return f.exists()&&!currentCredential(readWrapped(ctx,"pairing.wrapped"));}
  public static void clearPairing(Context ctx)throws Exception {
    File f=new File(ctx.getFilesDir(),"pairing.wrapped");
    if(f.exists()&&!f.delete())throw new IOException("无法删除本机配对信息");
  }
  static void writeWrapped(Context ctx,String file,JSONObject value)throws Exception {
    Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.ENCRYPT_MODE,wrappingKey());byte[] encrypted=c.doFinal(bytes(value.toString()));
    try(FileOutputStream f=ctx.openFileOutput(file,0)){f.write(join(c.getIV(),encrypted));}
  }
  static JSONObject readWrapped(Context ctx,String file)throws Exception {
    File f=new File(ctx.getFilesDir(),file);if(!f.exists())return null;byte[] data=java.nio.file.Files.readAllBytes(f.toPath());if(data.length<29)throw new GeneralSecurityException("加密设置已损坏");
    Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.DECRYPT_MODE,wrappingKey(),new GCMParameterSpec(128,Arrays.copyOfRange(data,0,12)));return new JSONObject(new String(c.doFinal(Arrays.copyOfRange(data,12,data.length)),StandardCharsets.UTF_8));
  }
  public static void saveProvider(Context ctx,JSONObject provider)throws Exception {writeWrapped(ctx,"provider.wrapped",provider);}
  public static JSONObject provider(Context ctx)throws Exception {return readWrapped(ctx,"provider.wrapped");}
  public static JSONObject selfTest()throws Exception {
    byte[] key=new byte[32],nonce=new byte[12];for(int i=0;i<key.length;i++)key[i]=(byte)i;for(int i=0;i<nonce.length;i++)nonce[i]=(byte)(i+16);
    long ts=1792064400L;String text="离线实验：明天下午三点开会。Android 与 Python 交叉验证。";
    byte[] blob=encrypt(text,key,ts,nonce);
    JSONObject j=new JSONObject().put("kind","crypto_self_test").put("test_only",true).put("timestamp",ts).put("plaintext",text).put("test_kek_hex",hex(key)).put("nonce_hex",hex(nonce)).put("blob_hex",hex(blob)).put("content_hash",hex(sha(blob))).put("roundtrip",decrypt(blob,key,ts).equals(text));
    byte[] tampered=blob.clone();tampered[tampered.length-1]^=1;
    boolean rejects=false;try{decrypt(tampered,key,ts);}catch(GeneralSecurityException e){rejects=true;}
    j.put("tamper_rejected",rejects);return j;
  }
}
