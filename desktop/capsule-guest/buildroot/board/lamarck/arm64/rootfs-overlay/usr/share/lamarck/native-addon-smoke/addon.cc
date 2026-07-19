#include <node_api.h>

static napi_value Answer(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value result;
  if (napi_create_int32(env, 42, &result) != napi_ok) return nullptr;
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value answer;
  if (napi_create_function(env, "answer", NAPI_AUTO_LENGTH, Answer, nullptr, &answer) != napi_ok) {
    return nullptr;
  }
  if (napi_set_named_property(env, exports, "answer", answer) != napi_ok) return nullptr;
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
