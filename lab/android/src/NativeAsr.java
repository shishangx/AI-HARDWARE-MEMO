package im.privatememo.lab;
public final class NativeAsr {
    static { System.loadLibrary("memo_native"); }
    public static native double load(String root, String model, int threads);
    public static native String transcribe(float[] pcm);
    public static native String generate(String prompt, int maxTokens);
    public static native int[] segments(String vadPath, float[] pcm);
    public static native void release();
}
