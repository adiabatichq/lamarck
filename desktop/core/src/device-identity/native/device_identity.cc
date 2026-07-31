#include <node_api.h>

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <vector>

#ifdef __APPLE__
#include <time.h>
#include <unistd.h>
#endif

#ifdef _WIN32
#include <winrt/Windows.Storage.Streams.h>
#include <winrt/Windows.System.Profile.h>
#include <winrt/base.h>
#endif

namespace {

#ifdef __APPLE__
constexpr std::size_t kDarwinIdentifierBytes = 16;
#endif
#ifdef _WIN32
constexpr std::uint32_t kWindowsIdentifierMaxBytes = 1024;
#endif

void SecureZero(void* data, std::size_t length) {
  volatile std::uint8_t* bytes = static_cast<volatile std::uint8_t*>(data);
  while (length-- > 0) *bytes++ = 0;
}

napi_value ThrowUnavailable(napi_env env) {
  napi_throw_error(env, nullptr, "Device identity primitive is unavailable.");
  return nullptr;
}

napi_value GetHostUuid(napi_env env, napi_callback_info info) {
#ifdef __APPLE__
  std::size_t argc = 1;
  napi_value args[1];
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1) {
    return ThrowUnavailable(env);
  }

  double timeout_seconds = 0;
  if (napi_get_value_double(env, args[0], &timeout_seconds) != napi_ok
      || !std::isfinite(timeout_seconds)
      || timeout_seconds < 1
      || timeout_seconds > 60
      || std::floor(timeout_seconds) != timeout_seconds) {
    return ThrowUnavailable(env);
  }

  unsigned char identifier[kDarwinIdentifierBytes] = {};
  const struct timespec wait = {static_cast<time_t>(timeout_seconds), 0};
  if (gethostuuid(identifier, &wait) != 0) {
    SecureZero(identifier, sizeof(identifier));
    return ThrowUnavailable(env);
  }

  bool all_zero = true;
  for (const unsigned char byte : identifier) {
    if (byte != 0) {
      all_zero = false;
      break;
    }
  }
  if (all_zero) {
    SecureZero(identifier, sizeof(identifier));
    return ThrowUnavailable(env);
  }

  napi_value result;
  const napi_status status = napi_create_buffer_copy(
      env,
      sizeof(identifier),
      identifier,
      nullptr,
      &result);
  SecureZero(identifier, sizeof(identifier));
  if (status != napi_ok) return ThrowUnavailable(env);
  return result;
#else
  (void)info;
  return ThrowUnavailable(env);
#endif
}

#ifdef _WIN32
class SecureByteVector {
 public:
  explicit SecureByteVector(std::size_t size) : value(size) {}
  ~SecureByteVector() {
    if (!value.empty()) SecureZero(value.data(), value.size());
  }

  std::vector<std::uint8_t> value;
};

class WinrtApartment {
 public:
  WinrtApartment() {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    initialized_ = true;
  }
  ~WinrtApartment() {
    if (initialized_) winrt::uninit_apartment();
  }

 private:
  bool initialized_ = false;
};

const char* SourceName(winrt::Windows::System::Profile::SystemIdentificationSource source) {
  using winrt::Windows::System::Profile::SystemIdentificationSource;
  switch (source) {
    case SystemIdentificationSource::Tpm:
      return "Tpm";
    case SystemIdentificationSource::Uefi:
      return "Uefi";
    case SystemIdentificationSource::Registry:
      return "Registry";
    case SystemIdentificationSource::None:
    default:
      return nullptr;
  }
}
#endif

napi_value GetSystemIdForPublisher(napi_env env, napi_callback_info info) {
  (void)info;
#ifdef _WIN32
  try {
    WinrtApartment apartment;
    using winrt::Windows::Storage::Streams::DataReader;
    using winrt::Windows::System::Profile::SystemIdentification;

    const auto system_info = SystemIdentification::GetSystemIdForPublisher();
    if (!system_info) return ThrowUnavailable(env);

    const char* source = SourceName(system_info.Source());
    if (source == nullptr) return ThrowUnavailable(env);

    const auto identifier = system_info.Id();
    if (!identifier) return ThrowUnavailable(env);
    const std::uint32_t length = identifier.Length();
    if (length == 0 || length > kWindowsIdentifierMaxBytes) {
      return ThrowUnavailable(env);
    }

    SecureByteVector bytes(length);
    const auto reader = DataReader::FromBuffer(identifier);
    reader.ReadBytes(bytes.value);

    napi_value result;
    napi_value source_value;
    napi_value id_value;
    if (napi_create_object(env, &result) != napi_ok
        || napi_create_string_utf8(env, source, NAPI_AUTO_LENGTH, &source_value) != napi_ok
        || napi_set_named_property(env, result, "source", source_value) != napi_ok
        || napi_create_buffer_copy(
            env,
            bytes.value.size(),
            bytes.value.data(),
            nullptr,
            &id_value) != napi_ok
        || napi_set_named_property(env, result, "id", id_value) != napi_ok) {
      return ThrowUnavailable(env);
    }
    return result;
  } catch (...) {
    return ThrowUnavailable(env);
  }
#else
  return ThrowUnavailable(env);
#endif
}

napi_value Initialize(napi_env env, napi_value exports) {
  napi_value get_host_uuid;
  napi_value get_system_id;
  if (napi_create_function(
          env,
          "getHostUuid",
          NAPI_AUTO_LENGTH,
          GetHostUuid,
          nullptr,
          &get_host_uuid) != napi_ok
      || napi_create_function(
          env,
          "getSystemIdForPublisher",
          NAPI_AUTO_LENGTH,
          GetSystemIdForPublisher,
          nullptr,
          &get_system_id) != napi_ok
      || napi_set_named_property(env, exports, "getHostUuid", get_host_uuid) != napi_ok
      || napi_set_named_property(
          env,
          exports,
          "getSystemIdForPublisher",
          get_system_id) != napi_ok) {
    return ThrowUnavailable(env);
  }
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
