#include <jni.h>
#include <algorithm>
#include <chrono>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>
#include "sherpa-c-api.h"
#include "llama.h"
#include "mtmd.h"
#include "mtmd-helper.h"

static std::mutex guard;
static const SherpaOnnxOfflineRecognizer* recognizer = nullptr;
static llama_model* model = nullptr;
static llama_context* ctx = nullptr;
static mtmd_context* audio_ctx = nullptr;
static std::string active;
static double load_ms = 0;
static double millis() { return std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count(); }
static std::string str(JNIEnv* e, jstring v) { const char* p=e->GetStringUTFChars(v,nullptr); std::string s(p); e->ReleaseStringUTFChars(v,p); return s; }
static jstring js(JNIEnv* e, const std::string& s) {
  jbyteArray a=e->NewByteArray(s.size()); e->SetByteArrayRegion(a,0,s.size(),reinterpret_cast<const jbyte*>(s.data()));
  jclass c=e->FindClass("java/lang/String"); auto ctor=e->GetMethodID(c,"<init>","([BLjava/lang/String;)V");
  auto encoding=e->NewStringUTF("UTF-8"); return (jstring)e->NewObject(c,ctor,a,encoding);
}
static void clear() {
  if(recognizer) { SherpaOnnxDestroyOfflineRecognizer(recognizer); recognizer=nullptr; }
  if(audio_ctx) { mtmd_free(audio_ctx); audio_ctx=nullptr; }
  if(ctx) { llama_free(ctx); ctx=nullptr; }
  if(model) { llama_model_free(model); model=nullptr; }
  active.clear();
}
static void fail(JNIEnv* e,const std::exception& x) { clear(); e->ThrowNew(e->FindClass("java/lang/RuntimeException"),x.what()); }

extern "C" JNIEXPORT jdouble JNICALL Java_im_privatememo_lab_NativeAsr_load(JNIEnv* e,jclass,jstring root,jstring kind,jint threads) {
  std::lock_guard<std::mutex> lock(guard);
  try {
    std::string base=str(e,root), name=str(e,kind);
    std::string key=base+name+std::to_string(threads);
    if(active==key) return 0;
    clear(); double t=millis();
    if(name=="summary") {
      llama_backend_init();
      auto mp=llama_model_default_params();mp.n_gpu_layers=0;
      model=llama_model_load_from_file((base+"/summary/Qwen3-0.6B-Q4_K_M.gguf").c_str(),mp);
      if(!model)throw std::runtime_error("本地摘要模型未安装");
      auto cp=llama_context_default_params();cp.n_ctx=4096;cp.n_batch=512;cp.n_ubatch=512;
      cp.n_threads=threads;cp.n_threads_batch=threads;cp.n_seq_max=1;cp.offload_kqv=false;
      cp.flash_attn_type=LLAMA_FLASH_ATTN_TYPE_ENABLED;
      ctx=llama_init_from_model(model,cp);if(!ctx)throw std::runtime_error("摘要模型 context 创建失败");
    } else if(name=="r2t2") {
      llama_backend_init();
      auto mp=llama_model_default_params(); mp.n_gpu_layers=0;
      model=llama_model_load_from_file((base+"/r2t2/Confucius4-R2T2-Q4_K_M.gguf").c_str(),mp);
      if(!model) throw std::runtime_error("R2T2 main model load failed");
      auto cp=llama_context_default_params(); cp.n_ctx=2048; cp.n_batch=512; cp.n_ubatch=512;
      cp.n_threads=threads; cp.n_threads_batch=threads; cp.n_seq_max=1; cp.offload_kqv=false;
      cp.flash_attn_type=LLAMA_FLASH_ATTN_TYPE_ENABLED;
      ctx=llama_init_from_model(model,cp); if(!ctx) throw std::runtime_error("R2T2 context failed");
      auto ap=mtmd_context_params_default(); ap.use_gpu=false; ap.n_threads=threads; ap.warmup=false;
      audio_ctx=mtmd_init_from_file((base+"/r2t2/mmproj-Confucius4-R2T2-Q8_0.gguf").c_str(),model,ap);
      if(!audio_ctx || !mtmd_support_audio(audio_ctx)) throw std::runtime_error("R2T2 audio projector failed");
    } else {
      std::string dir=base+"/"+name, path=dir+"/model.int8.onnx", tokens=dir+"/tokens.txt";
      SherpaOnnxOfflineRecognizerConfig cfg{};
      cfg.feat_config.sample_rate=16000; cfg.feat_config.feature_dim=80;
      cfg.model_config.tokens=tokens.c_str(); cfg.model_config.num_threads=threads; cfg.model_config.provider="cpu";
      cfg.decoding_method="greedy_search";
      if(name=="sensevoice") { cfg.model_config.sense_voice.model=path.c_str(); cfg.model_config.sense_voice.language="auto"; cfg.model_config.sense_voice.use_itn=1; }
      else if(name=="paraformer") cfg.model_config.paraformer.model=path.c_str();
      else throw std::runtime_error("Unsupported model");
      recognizer=SherpaOnnxCreateOfflineRecognizer(&cfg);
      if(!recognizer) throw std::runtime_error("sherpa model load failed");
    }
    load_ms=millis()-t; active=key; return load_ms;
  } catch(const std::exception& x) { fail(e,x); return -1; }
}

extern "C" JNIEXPORT jstring JNICALL Java_im_privatememo_lab_NativeAsr_generate(JNIEnv* e,jclass,jstring input,jint max_tokens) {
  std::lock_guard<std::mutex> lock(guard);
  try {
    if(!model || !ctx || active.find("summary")==std::string::npos)throw std::runtime_error("请先加载本地摘要模型");
    std::string user=str(e,input);if(user.empty())throw std::runtime_error("摘要输入为空");
    int limit=std::max(32,std::min((int)max_tokens,768));
    std::string prompt="<|im_start|>system\n你是离线语音备忘录的摘要助手。只依据提供的记录回答，不补充未出现的事实。<|im_end|>\n<|im_start|>user\n"+user+"\n/no_think<|im_end|>\n<|im_start|>assistant\n";
    auto* vocab=llama_model_get_vocab(model);int n=-llama_tokenize(vocab,prompt.data(),prompt.size(),nullptr,0,true,true);
    if(n<=0)throw std::runtime_error("摘要输入分词失败");
    if(n+limit+8>(int)llama_n_ctx(ctx))throw std::runtime_error("摘要输入过长");
    std::vector<llama_token> in(n);if(llama_tokenize(vocab,prompt.data(),prompt.size(),in.data(),in.size(),true,true)<0)throw std::runtime_error("摘要输入分词失败");
    llama_memory_clear(llama_get_memory(ctx),true);for(int off=0;off<n;off+=512){int take=std::min(512,n-off);if(llama_decode(ctx,llama_batch_get_one(in.data()+off,take)))throw std::runtime_error("摘要模型预填充失败");}
    auto sp=llama_sampler_chain_default_params();auto* sampler=llama_sampler_chain_init(sp);
    llama_sampler_chain_add(sampler,llama_sampler_init_top_k(20));
    llama_sampler_chain_add(sampler,llama_sampler_init_top_p(0.90f,1));
    llama_sampler_chain_add(sampler,llama_sampler_init_temp(0.35f));
    llama_sampler_chain_add(sampler,llama_sampler_init_dist(0x50564d45));
    std::vector<llama_token> out;for(int i=0;i<limit;i++){auto token=llama_sampler_sample(sampler,ctx,-1);llama_sampler_accept(sampler,token);if(llama_vocab_is_eog(vocab,token))break;out.push_back(token);if(llama_decode(ctx,llama_batch_get_one(&token,1))){llama_sampler_free(sampler);throw std::runtime_error("摘要模型生成失败");}}llama_sampler_free(sampler);
    std::vector<char> buf(out.size()*16+256);int size=llama_detokenize(vocab,out.data(),out.size(),buf.data(),buf.size(),true,true);if(size<0){buf.resize(-size);size=llama_detokenize(vocab,out.data(),out.size(),buf.data(),buf.size(),true,true);}if(size<0)throw std::runtime_error("摘要结果解码失败");return js(e,std::string(buf.data(),size));
  }catch(const std::exception& x){fail(e,x);return nullptr;}
}

extern "C" JNIEXPORT jstring JNICALL Java_im_privatememo_lab_NativeAsr_transcribe(JNIEnv* e,jclass,jfloatArray samples) {
  std::lock_guard<std::mutex> lock(guard);
  try {
    auto n=e->GetArrayLength(samples); if(n<=0) throw std::runtime_error("Empty audio");
    std::vector<float> pcm(n); e->GetFloatArrayRegion(samples,0,n,pcm.data());
    std::string out;
    if(recognizer) {
      const auto* stream=SherpaOnnxCreateOfflineStream(recognizer);
      if(!stream) throw std::runtime_error("ASR stream creation failed");
      SherpaOnnxAcceptWaveformOffline(stream,16000,pcm.data(),n);
      SherpaOnnxDecodeOfflineStream(recognizer,stream);
      const auto* result=SherpaOnnxGetOfflineStreamResult(stream);
      if(result && result->text) out=result->text;
      if(result) SherpaOnnxDestroyOfflineRecognizerResult(result);
      SherpaOnnxDestroyOfflineStream(stream);
    } else if(model && ctx && audio_ctx) {
      llama_memory_clear(llama_get_memory(ctx),true);
      std::string prompt="<|im_start|>system\n<|im_end|>\n<|im_start|>user\n";
      prompt+=mtmd_default_marker(); prompt+="<|im_end|>\n<|im_start|>assistant\nlanguage Chinese<asr_text>";
      mtmd_bitmap* bitmap=mtmd_bitmap_init_from_audio(pcm.size(),pcm.data());
      if(!bitmap) throw std::runtime_error("Audio bitmap creation failed");
      const mtmd_bitmap* bitmaps[]={bitmap};
      mtmd_input_text text{prompt.data(),prompt.size(),true,true};
      auto* chunks=mtmd_input_chunks_init();
      int rc=mtmd_tokenize(audio_ctx,chunks,&text,bitmaps,1);
      if(rc) {mtmd_input_chunks_free(chunks);mtmd_bitmap_free(bitmap);throw std::runtime_error("Audio tokenize failed: "+std::to_string(rc));}
      llama_pos past=0;
      for(size_t i=0;i<mtmd_input_chunks_size(chunks);++i) {
        auto* chunk=mtmd_input_chunks_get(chunks,i); llama_pos next=past;
        if(mtmd_input_chunk_get_type(chunk)==MTMD_INPUT_CHUNK_TYPE_TEXT)
          rc=mtmd_helper_eval_chunk_single(audio_ctx,ctx,chunk,past,0,512,i+1==mtmd_input_chunks_size(chunks),&next);
        else {
          rc=mtmd_encode_chunk(audio_ctx,chunk);
          if(!rc) rc=mtmd_helper_decode_image_chunk(audio_ctx,ctx,chunk,mtmd_get_output_embd(audio_ctx),past,0,512,&next,nullptr,nullptr);
        }
        if(rc) break;
        past=next;
      }
      mtmd_input_chunks_free(chunks); mtmd_bitmap_free(bitmap);
      if(rc) throw std::runtime_error("R2T2 audio prefill failed: "+std::to_string(rc));
      auto* sampler=llama_sampler_init_greedy(); auto* vocab=llama_model_get_vocab(model);
      std::vector<llama_token> tokens;
      for(int i=0;i<256;++i) {
        auto token=llama_sampler_sample(sampler,ctx,-1); llama_sampler_accept(sampler,token);
        if(llama_vocab_is_eog(vocab,token)) break;
        tokens.push_back(token); auto batch=llama_batch_get_one(&token,1);
        if(llama_decode(ctx,batch)) {llama_sampler_free(sampler);throw std::runtime_error("R2T2 decoding failed or context exhausted");}
      }
      llama_sampler_free(sampler);
      std::vector<char> buf(tokens.size()*16+256);
      int size=llama_detokenize(vocab,tokens.data(),tokens.size(),buf.data(),buf.size(),true,true);
      if(size<0) {buf.resize(-size);size=llama_detokenize(vocab,tokens.data(),tokens.size(),buf.data(),buf.size(),true,true);}
      if(size<0) throw std::runtime_error("R2T2 detokenization failed");
      out.assign(buf.data(),size);
    } else throw std::runtime_error("Load a model first");
    return js(e,out);
  } catch(const std::exception& x) {fail(e,x);return nullptr;}
}

extern "C" JNIEXPORT void JNICALL Java_im_privatememo_lab_NativeAsr_release(JNIEnv*,jclass) {std::lock_guard<std::mutex> lock(guard);clear();}

extern "C" JNIEXPORT jintArray JNICALL Java_im_privatememo_lab_NativeAsr_segments(JNIEnv* e,jclass,jstring path,jfloatArray samples) {
  std::lock_guard<std::mutex> lock(guard);
  try {
    auto file=str(e,path); auto n=e->GetArrayLength(samples);std::vector<float> pcm(n);
    e->GetFloatArrayRegion(samples,0,n,pcm.data());
    SherpaOnnxVadModelConfig c{}; c.silero_vad.model=file.c_str();c.silero_vad.threshold=.5f;
    c.silero_vad.min_silence_duration=1.0f;c.silero_vad.min_speech_duration=.4f;
    c.silero_vad.max_speech_duration=15;c.silero_vad.window_size=512;
    c.sample_rate=16000;c.num_threads=1;c.provider="cpu";
    auto* vad=SherpaOnnxCreateVoiceActivityDetector(&c,120);
    if(!vad)throw std::runtime_error("VAD model load failed");
    std::vector<jint> ranges;
    auto drain=[&](){while(!SherpaOnnxVoiceActivityDetectorEmpty(vad)) {
      auto* s=SherpaOnnxVoiceActivityDetectorFront(vad);ranges.push_back(s->start);ranges.push_back(s->n);
      SherpaOnnxDestroySpeechSegment(s);SherpaOnnxVoiceActivityDetectorPop(vad);
    }};
    for(int i=0;i<n;i+=1600) {SherpaOnnxVoiceActivityDetectorAcceptWaveform(vad,pcm.data()+i,std::min(1600,n-i));drain();}
    SherpaOnnxVoiceActivityDetectorFlush(vad);drain();SherpaOnnxDestroyVoiceActivityDetector(vad);
    auto out=e->NewIntArray(ranges.size());if(!ranges.empty())e->SetIntArrayRegion(out,0,ranges.size(),ranges.data());return out;
  }catch(const std::exception& x){e->ThrowNew(e->FindClass("java/lang/RuntimeException"),x.what());return nullptr;}
}
