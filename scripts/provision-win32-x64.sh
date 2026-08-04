#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
LC_ALL=C

readonly BUILD_IMAGE='debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818'

readonly WHISPER_CPP_VERSION='v1.9.1'
readonly WHISPER_CPP_COMMIT='f049fff95a089aa9969deb009cdd4892b3e74916'
readonly WHISPER_CPP_URL='https://github.com/ggml-org/whisper.cpp.git'

readonly FFMPEG_VERSION='8.1.2'
readonly FFMPEG_ARCHIVE_SHA256='464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c'
readonly FFMPEG_ARCHIVE_URL="https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"

readonly MODEL_NAME='ggml-large-v3-turbo.bin'
readonly MODEL_SHA256='1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69'
readonly MODEL_REVISION='6034871ec87c84e342efab769d4c5c06cd126db3'
readonly MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/${MODEL_REVISION}/${MODEL_NAME}?download=true"

readonly SHERPA_ONNX_VERSION='1.13.4'
readonly SHERPA_NODE_ARCHIVE_URL="https://registry.npmjs.org/sherpa-onnx-node/-/sherpa-onnx-node-${SHERPA_ONNX_VERSION}.tgz"
readonly SHERPA_NODE_ARCHIVE_SHA512='8c7596758f5fd1d6ef26976c7d1fc2e16361339efe8d3f4eb364720b8fea533f07282b63d95605989f6ceedb9ef4e08544099da06064824a83e9a059dc8f012b'
readonly SHERPA_WINDOWS_ARCHIVE_URL="https://registry.npmjs.org/sherpa-onnx-win-x64/-/sherpa-onnx-win-x64-${SHERPA_ONNX_VERSION}.tgz"
readonly SHERPA_WINDOWS_ARCHIVE_SHA512='4743d66f2d55c42d784c364fabb19c7d2c97498e920053bc63827074276aa2e166797919d4bec8b3d9bdf02f4ac50d1d37b66d0f3840984ff8dc552cfde95745'

readonly SHERPA_LICENSE_URL="https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/v${SHERPA_ONNX_VERSION}/LICENSE"
readonly SHERPA_LICENSE_SHA256='cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'
readonly ONNXRUNTIME_VERSION='1.27.0'
readonly ONNXRUNTIME_LICENSE_URL="https://raw.githubusercontent.com/microsoft/onnxruntime/v${ONNXRUNTIME_VERSION}/LICENSE"
readonly ONNXRUNTIME_LICENSE_SHA256='2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c'
readonly ONNXRUNTIME_NOTICES_URL="https://raw.githubusercontent.com/microsoft/onnxruntime/v${ONNXRUNTIME_VERSION}/ThirdPartyNotices.txt"
readonly ONNXRUNTIME_NOTICES_SHA256='0e07b95f3a8d6230037707c5c4a2b554d12c4cb67369669ac255635528ffcee2'

readonly PYANNOTE_ARCHIVE_NAME='sherpa-onnx-pyannote-segmentation-3-0.tar.bz2'
readonly PYANNOTE_ARCHIVE_SHA256='24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488'
readonly PYANNOTE_ARCHIVE_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/${PYANNOTE_ARCHIVE_NAME}"
readonly PYANNOTE_ARCHIVE_MODEL_PATH='sherpa-onnx-pyannote-segmentation-3-0/model.onnx'
readonly PYANNOTE_MODEL_NAME='pyannote-segmentation-3.0.onnx'
readonly PYANNOTE_MODEL_SHA256='220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079'
readonly SPEAKER_EMBEDDING_MODEL_NAME='3dspeaker-eres2net-base.onnx'
readonly SPEAKER_EMBEDDING_MODEL_SHA256='1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b'
readonly SPEAKER_EMBEDDING_MODEL_URL='https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx'

SCRIPT_DIRECTORY="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
readonly SCRIPT_DIRECTORY
REPOSITORY_ROOT="$(CDPATH='' cd -- "${SCRIPT_DIRECTORY}/.." && pwd)"
readonly REPOSITORY_ROOT

readonly RUNTIME_BUILD_ROOT="${REPOSITORY_ROOT}/.build/runtime/win32-x64"
readonly DOWNLOAD_DIRECTORY="${RUNTIME_BUILD_ROOT}/downloads"
readonly SOURCE_DIRECTORY="${RUNTIME_BUILD_ROOT}/sources"
readonly BUILD_DIRECTORY="${RUNTIME_BUILD_ROOT}/build"
readonly TEMPORARY_DIRECTORY="${RUNTIME_BUILD_ROOT}/temporary"
readonly WHISPER_SOURCE_DIRECTORY="${SOURCE_DIRECTORY}/whisper.cpp-${WHISPER_CPP_VERSION}"
readonly WHISPER_BUILD_DIRECTORY="${BUILD_DIRECTORY}/whisper.cpp-${WHISPER_CPP_VERSION}"
readonly FFMPEG_ARCHIVE_PATH="${DOWNLOAD_DIRECTORY}/ffmpeg-${FFMPEG_VERSION}.tar.xz"
readonly FFMPEG_SOURCE_DIRECTORY="${SOURCE_DIRECTORY}/ffmpeg-${FFMPEG_VERSION}"
readonly FFMPEG_BUILD_DIRECTORY="${BUILD_DIRECTORY}/ffmpeg-${FFMPEG_VERSION}"
readonly MODEL_CACHE_PATH="${DOWNLOAD_DIRECTORY}/${MODEL_NAME}"
readonly PYANNOTE_ARCHIVE_CACHE_PATH="${DOWNLOAD_DIRECTORY}/${PYANNOTE_ARCHIVE_NAME}"
readonly SPEAKER_EMBEDDING_MODEL_CACHE_PATH="${DOWNLOAD_DIRECTORY}/${SPEAKER_EMBEDDING_MODEL_NAME}"
readonly SHERPA_NODE_ARCHIVE_PATH="${DOWNLOAD_DIRECTORY}/sherpa-onnx-node-${SHERPA_ONNX_VERSION}.tgz"
readonly SHERPA_WINDOWS_ARCHIVE_PATH="${DOWNLOAD_DIRECTORY}/sherpa-onnx-win-x64-${SHERPA_ONNX_VERSION}.tgz"
readonly SHERPA_LICENSE_CACHE_PATH="${DOWNLOAD_DIRECTORY}/sherpa-onnx-${SHERPA_ONNX_VERSION}.LICENSE"
readonly ONNXRUNTIME_LICENSE_CACHE_PATH="${DOWNLOAD_DIRECTORY}/onnxruntime-${ONNXRUNTIME_VERSION}.LICENSE"
readonly ONNXRUNTIME_NOTICES_CACHE_PATH="${DOWNLOAD_DIRECTORY}/onnxruntime-${ONNXRUNTIME_VERSION}.ThirdPartyNotices.txt"

readonly SIDECAR_STAGE_DIRECTORY="${REPOSITORY_ROOT}/resources/sidecars/win32-x64"
readonly MODEL_STAGE_DIRECTORY="${REPOSITORY_ROOT}/resources/models"
readonly MODEL_STAGE_PATH="${MODEL_STAGE_DIRECTORY}/${MODEL_NAME}"
readonly DIARIZATION_STAGE_DIRECTORY="${REPOSITORY_ROOT}/resources/diarization"
readonly PYANNOTE_MODEL_STAGE_PATH="${DIARIZATION_STAGE_DIRECTORY}/${PYANNOTE_MODEL_NAME}"
readonly SPEAKER_EMBEDDING_MODEL_STAGE_PATH="${DIARIZATION_STAGE_DIRECTORY}/${SPEAKER_EMBEDDING_MODEL_NAME}"
readonly SPEAKER_RUNTIME_STAGE_DIRECTORY="${REPOSITORY_ROOT}/resources/speaker-runtime"
readonly LICENSE_STAGE_DIRECTORY="${SIDECAR_STAGE_DIRECTORY}/licenses"
readonly SHARED_LICENSE_STAGE_DIRECTORY="${REPOSITORY_ROOT}/resources/sidecars/licenses"
readonly RUNTIME_MANIFEST_PATH="${SIDECAR_STAGE_DIRECTORY}/runtime-manifest.json"

log() {
  printf '[sotto-windows-runtime] %s\n' "$*"
}

fail() {
  printf '[sotto-windows-runtime] ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command is unavailable: $1"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -- "$1" | awk '{print $1}'
  else
    shasum -a 256 -- "$1" | awk '{print $1}'
  fi
}

sha512_file() {
  if command -v sha512sum >/dev/null 2>&1; then
    sha512sum -- "$1" | awk '{print $1}'
  else
    shasum -a 512 -- "$1" | awk '{print $1}'
  fi
}

verify_digest() {
  local algorithm="$1"
  local path="$2"
  local expected="$3"
  local label="$4"
  local actual

  [[ -f "${path}" ]] || fail "${label} is missing: ${path}"
  if [[ "${algorithm}" == 'sha512' ]]; then
    actual="$(sha512_file "${path}")"
  else
    actual="$(sha256_file "${path}")"
  fi
  [[ "${actual}" == "${expected}" ]] || fail \
    "${label} ${algorithm} mismatch (expected ${expected}, got ${actual})."
}

download_verified_file() {
  local url="$1"
  local algorithm="$2"
  local expected="$3"
  local destination="$4"
  local label="$5"
  local temporary_download

  if [[ -e "${destination}" ]]; then
    verify_digest "${algorithm}" "${destination}" "${expected}" "${label}"
    log "Using verified cached ${label}."
    return
  fi

  temporary_download="$(mktemp "${TEMPORARY_DIRECTORY}/download.XXXXXX")"
  log "Downloading ${label} from its pinned HTTPS source."
  curl \
    --fail \
    --location \
    --proto '=https' \
    --retry 3 \
    --retry-all-errors \
    --show-error \
    --silent \
    --output "${temporary_download}" \
    "${url}"
  verify_digest "${algorithm}" "${temporary_download}" "${expected}" "${label}"
  mv -- "${temporary_download}" "${destination}"
}

prepare_whisper_source() {
  local origin_url
  local tag_commit

  if [[ ! -e "${WHISPER_SOURCE_DIRECTORY}" ]]; then
    log "Cloning whisper.cpp ${WHISPER_CPP_VERSION}."
    git clone \
      --branch "${WHISPER_CPP_VERSION}" \
      --depth=1 \
      --filter=blob:none \
      "${WHISPER_CPP_URL}" \
      "${WHISPER_SOURCE_DIRECTORY}"
  fi
  [[ -d "${WHISPER_SOURCE_DIRECTORY}/.git" ]] || fail \
    "Expected a Git checkout at ${WHISPER_SOURCE_DIRECTORY}."
  origin_url="$(git -C "${WHISPER_SOURCE_DIRECTORY}" remote get-url origin)"
  [[ "${origin_url}" == "${WHISPER_CPP_URL}" ]] || fail "Unexpected whisper.cpp origin: ${origin_url}"
  [[ -z "$(git -C "${WHISPER_SOURCE_DIRECTORY}" status --porcelain --untracked-files=normal)" ]] || fail \
    "The cached whisper.cpp source has local changes."
  tag_commit="$(git -C "${WHISPER_SOURCE_DIRECTORY}" rev-list -n 1 "refs/tags/${WHISPER_CPP_VERSION}")"
  [[ "${tag_commit}" == "${WHISPER_CPP_COMMIT}" ]] || fail \
    "whisper.cpp ${WHISPER_CPP_VERSION} resolved to ${tag_commit}, not ${WHISPER_CPP_COMMIT}."
  git -C "${WHISPER_SOURCE_DIRECTORY}" -c advice.detachedHead=false checkout --detach "${WHISPER_CPP_COMMIT}"
}

prepare_ffmpeg_source() {
  local extraction_directory
  local extracted_source

  download_verified_file \
    "${FFMPEG_ARCHIVE_URL}" \
    sha256 \
    "${FFMPEG_ARCHIVE_SHA256}" \
    "${FFMPEG_ARCHIVE_PATH}" \
    "FFmpeg ${FFMPEG_VERSION} source archive"

  [[ -x "${FFMPEG_SOURCE_DIRECTORY}/configure" ]] && return
  extraction_directory="$(mktemp -d "${TEMPORARY_DIRECTORY}/ffmpeg-source.XXXXXX")"
  tar -xJf "${FFMPEG_ARCHIVE_PATH}" -C "${extraction_directory}"
  extracted_source="${extraction_directory}/ffmpeg-${FFMPEG_VERSION}"
  [[ -x "${extracted_source}/configure" ]] || fail 'The FFmpeg archive was incomplete.'
  [[ ! -e "${FFMPEG_SOURCE_DIRECTORY}" ]] || fail \
    "Cached FFmpeg source is incomplete: ${FFMPEG_SOURCE_DIRECTORY}"
  mv -- "${extracted_source}" "${FFMPEG_SOURCE_DIRECTORY}"
}

verify_pe_x64() {
  local binary_path="$1"
  local label="$2"
  local description

  [[ -f "${binary_path}" ]] || fail "${label} is missing: ${binary_path}"
  description="$(file -b "${binary_path}")"
  grep -Eq 'PE32\+ executable .*x86-64' <<<"${description}" || fail \
    "${label} is not a Windows x64 PE executable: ${description}"
}

pe_objdump() {
  if command -v x86_64-w64-mingw32-objdump >/dev/null 2>&1; then
    x86_64-w64-mingw32-objdump "$@"
    return
  fi
  if command -v objdump >/dev/null 2>&1; then
    objdump "$@"
    return
  fi
  fail 'A PE-compatible objdump is required to verify Windows dependencies.'
}

verify_static_project_dependencies() {
  local binary_path="$1"
  local label="$2"
  local dependencies

  dependencies="$(pe_objdump -p "${binary_path}" | awk '/DLL Name:/ {print tolower($3)}')"
  if grep -Eq '(^|/)(libatomic|libgcc|libgomp|libstdc\+\+|libwinpthread|avcodec|avfilter|avformat|avutil|swresample|swscale|whisper|ggml)' <<<"${dependencies}"; then
    printf '%s\n' "${dependencies}" >&2
    fail "${label} has an unexpected project or MinGW runtime DLL dependency."
  fi
}

verify_speaker_runtime() {
  local native_directory="${SPEAKER_RUNTIME_STAGE_DIRECTORY}/sherpa-onnx-win-x64"
  local native_file
  local dependency
  local dependencies
  local -a native_files=(
    'sherpa-onnx.node'
    'onnxruntime.dll'
    'onnxruntime_providers_shared.dll'
    'sherpa-onnx-c-api.dll'
    'sherpa-onnx-cxx-api.dll'
  )

  for native_file in "${native_files[@]}"; do
    verify_pe_x64 "${native_directory}/${native_file}" "Windows speaker runtime ${native_file}"
    verify_static_project_dependencies \
      "${native_directory}/${native_file}" \
      "Windows speaker runtime ${native_file}"
    dependencies="$(pe_objdump -p "${native_directory}/${native_file}" | awk '/DLL Name:/ {print tolower($3)}')"
    while IFS= read -r dependency; do
      case "${dependency}" in
        onnxruntime*.dll|sherpa-onnx-*.dll)
          [[ -f "${native_directory}/${dependency}" ]] || fail \
            "Windows speaker runtime ${native_file} requires missing ${dependency}."
          ;;
      esac
    done <<<"${dependencies}"
  done
}

build_whisper_cli() {
  local whisper_binary="${WHISPER_BUILD_DIRECTORY}/bin/whisper-cli.exe"

  log 'Configuring a static AVX2/FMA/F16C whisper-cli.exe with MinGW.'
  cmake \
    -G 'Unix Makefiles' \
    -S "${WHISPER_SOURCE_DIRECTORY}" \
    -B "${WHISPER_BUILD_DIRECTORY}" \
    -DCMAKE_SYSTEM_NAME=Windows \
    -DCMAKE_SYSTEM_PROCESSOR=x86_64 \
    -DCMAKE_C_COMPILER=x86_64-w64-mingw32-gcc-posix \
    -DCMAKE_CXX_COMPILER=x86_64-w64-mingw32-g++-posix \
    -DCMAKE_RC_COMPILER=x86_64-w64-mingw32-windres \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_FLAGS='-D_WIN32_WINNT=0x0601' \
    -DCMAKE_CXX_FLAGS='-D_WIN32_WINNT=0x0601' \
    -DCMAKE_EXE_LINKER_FLAGS='-static -static-libgcc -static-libstdc++' \
    -DBUILD_SHARED_LIBS=OFF \
    -DGGML_BACKEND_DL=OFF \
    -DGGML_BLAS=OFF \
    -DGGML_SSE42=ON \
    -DGGML_AVX=ON \
    -DGGML_AVX2=ON \
    -DGGML_BMI2=ON \
    -DGGML_F16C=ON \
    -DGGML_FMA=ON \
    -DGGML_AVX512=OFF \
    -DGGML_CCACHE=OFF \
    -DGGML_CUDA=OFF \
    -DGGML_METAL=OFF \
    -DGGML_NATIVE=OFF \
    -DGGML_OPENMP=OFF \
    -DGGML_RPC=OFF \
    -DGGML_STATIC=ON \
    -DGGML_SYCL=OFF \
    -DGGML_VULKAN=OFF \
    -DWHISPER_BUILD_EXAMPLES=ON \
    -DWHISPER_BUILD_SERVER=OFF \
    -DWHISPER_BUILD_TESTS=OFF \
    -DWHISPER_COMMON_FFMPEG=OFF \
    -DWHISPER_COREML=OFF \
    -DWHISPER_CURL=OFF \
    -DWHISPER_OPENVINO=OFF \
    -DWHISPER_SDL2=OFF
  verify_whisper_cpu_build
  cmake --build "${WHISPER_BUILD_DIRECTORY}" --config Release --parallel "${BUILD_JOBS}" --target whisper-cli
  verify_pe_x64 "${whisper_binary}" 'whisper-cli.exe'
  verify_static_project_dependencies "${whisper_binary}" 'whisper-cli.exe'
}

verify_whisper_cpu_build() {
  local cache_path="${WHISPER_BUILD_DIRECTORY}/CMakeCache.txt"
  local flags_path="${WHISPER_BUILD_DIRECTORY}/ggml/src/CMakeFiles/ggml-cpu.dir/flags.make"
  local setting
  local flag

  for setting in \
    'GGML_SSE42:BOOL=ON' \
    'GGML_AVX:BOOL=ON' \
    'GGML_AVX2:BOOL=ON' \
    'GGML_BMI2:BOOL=ON' \
    'GGML_F16C:BOOL=ON' \
    'GGML_FMA:BOOL=ON' \
    'GGML_AVX512:BOOL=OFF' \
    'GGML_CUDA:BOOL=OFF' \
    'GGML_SYCL:BOOL=OFF' \
    'GGML_VULKAN:BOOL=OFF'; do
    grep -Fxq "${setting}" "${cache_path}" || fail \
      "Whisper CPU configuration is missing ${setting}."
  done

  [[ -f "${flags_path}" ]] || fail "Whisper CPU compiler flags are missing: ${flags_path}"
  for flag in -msse4.2 -mavx -mavx2 -mbmi2 -mf16c -mfma; do
    grep -Fq -- "${flag}" "${flags_path}" || fail \
      "Whisper CPU build is missing compiler flag ${flag}."
  done
}

build_ffmpeg() {
  local configure_output="${FFMPEG_BUILD_DIRECTORY}/configure-output.txt"
  local ffmpeg_binary="${FFMPEG_BUILD_DIRECTORY}/ffmpeg.exe"

  mkdir -p "${FFMPEG_BUILD_DIRECTORY}"
  log 'Configuring minimal static LGPL FFmpeg for Windows offline audio decoding.'
  (
    cd -- "${FFMPEG_BUILD_DIRECTORY}"
    "${FFMPEG_SOURCE_DIRECTORY}/configure" \
      --enable-cross-compile \
      --target-os=mingw32 \
      --arch=x86_64 \
      --cross-prefix=x86_64-w64-mingw32- \
      --cc=x86_64-w64-mingw32-gcc-posix \
      --cxx=x86_64-w64-mingw32-g++-posix \
      --host-cc=gcc \
      --disable-everything \
      --disable-autodetect \
      --disable-bzlib \
      --disable-d3d11va \
      --disable-d3d12va \
      --disable-network \
      --disable-doc \
      --disable-debug \
      --disable-dxva2 \
      --disable-ffplay \
      --disable-ffprobe \
      --disable-iconv \
      --disable-lzma \
      --disable-mediafoundation \
      --disable-schannel \
      --disable-zlib \
      --enable-ffmpeg \
      --enable-static \
      --disable-shared \
      --enable-small \
      --disable-pthreads \
      --enable-w32threads \
      --enable-protocol=file,pipe \
      --enable-demuxer=aac,asf,avi,flac,matroska,mov,mp3,mpegts,ogg,wav \
      --enable-decoder=aac,aac_fixed,alac,flac,mp3,mp3float,opus,vorbis,wavpack,wmav1,wmav2,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_f32le,pcm_f32be,pcm_u8,pcm_s8 \
      --enable-parser=aac,aac_latm,mpegaudio,opus,vorbis \
      --enable-encoder=pcm_s16le \
      --enable-muxer=wav \
      --enable-filter=anull,aformat,aresample \
      --extra-cflags=-D_WIN32_WINNT=0x0A00 \
      --extra-ldexeflags=-static \
      2>&1 | tee "${configure_output}"
  )
  grep -Eq '^License:[[:space:]]+LGPL version 2\.1 or later$' "${configure_output}" || fail \
    'FFmpeg did not report the required LGPL 2.1-or-later license.'
  grep -Eq '^network support[[:space:]]+no$' "${configure_output}" || fail \
    'FFmpeg did not report that network support is disabled.'
  make -C "${FFMPEG_BUILD_DIRECTORY}" -j "${BUILD_JOBS}" ffmpeg.exe
  verify_pe_x64 "${ffmpeg_binary}" 'ffmpeg.exe'
  verify_static_project_dependencies "${ffmpeg_binary}" 'ffmpeg.exe'
  if pe_objdump -p "${ffmpeg_binary}" | grep -Fiq 'ws2_32.dll'; then
    fail 'ffmpeg.exe imports the Windows networking library despite --disable-network.'
  fi
}

stage_file() {
  local source_path="$1"
  local destination_path="$2"
  local mode="$3"
  local destination_directory
  local temporary_stage

  destination_directory="$(dirname -- "${destination_path}")"
  mkdir -p "${destination_directory}"
  temporary_stage="$(mktemp "${destination_directory}/.stage-XXXXXX")"
  install -m "${mode}" "${source_path}" "${temporary_stage}"
  mv -f -- "${temporary_stage}" "${destination_path}"
}

stage_shared_models() {
  local extraction_directory

  if [[ ! -e "${MODEL_STAGE_PATH}" ]]; then
    download_verified_file "${MODEL_URL}" sha256 "${MODEL_SHA256}" "${MODEL_CACHE_PATH}" "${MODEL_NAME} model"
    stage_file "${MODEL_CACHE_PATH}" "${MODEL_STAGE_PATH}" 0644
  fi
  verify_digest sha256 "${MODEL_STAGE_PATH}" "${MODEL_SHA256}" "staged ${MODEL_NAME} model"

  if [[ ! -e "${PYANNOTE_MODEL_STAGE_PATH}" ]]; then
    download_verified_file \
      "${PYANNOTE_ARCHIVE_URL}" \
      sha256 \
      "${PYANNOTE_ARCHIVE_SHA256}" \
      "${PYANNOTE_ARCHIVE_CACHE_PATH}" \
      'Pyannote speaker-segmentation archive'
    extraction_directory="$(mktemp -d "${TEMPORARY_DIRECTORY}/pyannote.XXXXXX")"
    tar -xjf "${PYANNOTE_ARCHIVE_CACHE_PATH}" -C "${extraction_directory}"
    stage_file \
      "${extraction_directory}/${PYANNOTE_ARCHIVE_MODEL_PATH}" \
      "${PYANNOTE_MODEL_STAGE_PATH}" \
      0644
  fi
  verify_digest sha256 "${PYANNOTE_MODEL_STAGE_PATH}" "${PYANNOTE_MODEL_SHA256}" 'staged Pyannote model'

  if [[ ! -e "${SPEAKER_EMBEDDING_MODEL_STAGE_PATH}" ]]; then
    download_verified_file \
      "${SPEAKER_EMBEDDING_MODEL_URL}" \
      sha256 \
      "${SPEAKER_EMBEDDING_MODEL_SHA256}" \
      "${SPEAKER_EMBEDDING_MODEL_CACHE_PATH}" \
      '3D-Speaker embedding model'
    stage_file \
      "${SPEAKER_EMBEDDING_MODEL_CACHE_PATH}" \
      "${SPEAKER_EMBEDDING_MODEL_STAGE_PATH}" \
      0644
  fi
  verify_digest \
    sha256 \
    "${SPEAKER_EMBEDDING_MODEL_STAGE_PATH}" \
    "${SPEAKER_EMBEDDING_MODEL_SHA256}" \
    'staged 3D-Speaker model'
}

stage_speaker_runtime() {
  local extraction_directory
  local temporary_node
  local temporary_windows

  download_verified_file \
    "${SHERPA_NODE_ARCHIVE_URL}" \
    sha512 \
    "${SHERPA_NODE_ARCHIVE_SHA512}" \
    "${SHERPA_NODE_ARCHIVE_PATH}" \
    'sherpa-onnx-node package'
  download_verified_file \
    "${SHERPA_WINDOWS_ARCHIVE_URL}" \
    sha512 \
    "${SHERPA_WINDOWS_ARCHIVE_SHA512}" \
    "${SHERPA_WINDOWS_ARCHIVE_PATH}" \
    'sherpa-onnx-win-x64 package'

  extraction_directory="$(mktemp -d "${TEMPORARY_DIRECTORY}/speaker-runtime.XXXXXX")"
  mkdir -p "${extraction_directory}/node" "${extraction_directory}/windows"
  tar -xzf "${SHERPA_NODE_ARCHIVE_PATH}" -C "${extraction_directory}/node"
  tar -xzf "${SHERPA_WINDOWS_ARCHIVE_PATH}" -C "${extraction_directory}/windows"
  temporary_node="${SPEAKER_RUNTIME_STAGE_DIRECTORY}/.stage-sherpa-node"
  temporary_windows="${SPEAKER_RUNTIME_STAGE_DIRECTORY}/.stage-sherpa-windows"
  rm -rf -- "${temporary_node}" "${temporary_windows}"
  mkdir -p "${SPEAKER_RUNTIME_STAGE_DIRECTORY}"
  cp -R "${extraction_directory}/node/package" "${temporary_node}"
  cp -R "${extraction_directory}/windows/package" "${temporary_windows}"
  rm -rf -- \
    "${SPEAKER_RUNTIME_STAGE_DIRECTORY}/sherpa-onnx-node" \
    "${SPEAKER_RUNTIME_STAGE_DIRECTORY}/sherpa-onnx-win-x64"
  mv -- "${temporary_node}" "${SPEAKER_RUNTIME_STAGE_DIRECTORY}/sherpa-onnx-node"
  mv -- "${temporary_windows}" "${SPEAKER_RUNTIME_STAGE_DIRECTORY}/sherpa-onnx-win-x64"
  [[ -f "${SPEAKER_RUNTIME_STAGE_DIRECTORY}/sherpa-onnx-node/sherpa-onnx.js" ]] || fail \
    'The staged sherpa JavaScript package is incomplete.'
  [[ -f "${SPEAKER_RUNTIME_STAGE_DIRECTORY}/sherpa-onnx-win-x64/sherpa-onnx.node" ]] || fail \
    'The staged Windows sherpa native package is incomplete.'
}

stage_runtime_licenses() {
  download_verified_file \
    "${SHERPA_LICENSE_URL}" \
    sha256 \
    "${SHERPA_LICENSE_SHA256}" \
    "${SHERPA_LICENSE_CACHE_PATH}" \
    "sherpa-onnx ${SHERPA_ONNX_VERSION} Apache-2.0 license"
  download_verified_file \
    "${ONNXRUNTIME_LICENSE_URL}" \
    sha256 \
    "${ONNXRUNTIME_LICENSE_SHA256}" \
    "${ONNXRUNTIME_LICENSE_CACHE_PATH}" \
    "ONNX Runtime ${ONNXRUNTIME_VERSION} license"
  download_verified_file \
    "${ONNXRUNTIME_NOTICES_URL}" \
    sha256 \
    "${ONNXRUNTIME_NOTICES_SHA256}" \
    "${ONNXRUNTIME_NOTICES_CACHE_PATH}" \
    "ONNX Runtime ${ONNXRUNTIME_VERSION} third-party notices"

  stage_file \
    "${SHERPA_LICENSE_CACHE_PATH}" \
    "${SHARED_LICENSE_STAGE_DIRECTORY}/sherpa-onnx.Apache-2.0.LICENSE" \
    0644
  stage_file \
    "${SHERPA_LICENSE_CACHE_PATH}" \
    "${SHARED_LICENSE_STAGE_DIRECTORY}/3D-Speaker.Apache-2.0.LICENSE" \
    0644
  stage_file \
    "${ONNXRUNTIME_LICENSE_CACHE_PATH}" \
    "${SHARED_LICENSE_STAGE_DIRECTORY}/onnxruntime.LICENSE" \
    0644
  stage_file \
    "${ONNXRUNTIME_NOTICES_CACHE_PATH}" \
    "${SHARED_LICENSE_STAGE_DIRECTORY}/onnxruntime.ThirdPartyNotices.txt" \
    0644
}

write_runtime_manifest() {
  local ffmpeg_sha256
  local manifest
  local onnxruntime_sha256
  local onnxruntime_providers_sha256
  local sherpa_addon_sha256
  local sherpa_c_api_sha256
  local sherpa_cxx_api_sha256
  local speaker_native_directory="${SPEAKER_RUNTIME_STAGE_DIRECTORY}/sherpa-onnx-win-x64"
  local whisper_sha256

  whisper_sha256="$(sha256_file "${SIDECAR_STAGE_DIRECTORY}/whisper-cli.exe")"
  ffmpeg_sha256="$(sha256_file "${SIDECAR_STAGE_DIRECTORY}/ffmpeg.exe")"
  sherpa_addon_sha256="$(sha256_file "${speaker_native_directory}/sherpa-onnx.node")"
  onnxruntime_sha256="$(sha256_file "${speaker_native_directory}/onnxruntime.dll")"
  onnxruntime_providers_sha256="$(sha256_file "${speaker_native_directory}/onnxruntime_providers_shared.dll")"
  sherpa_c_api_sha256="$(sha256_file "${speaker_native_directory}/sherpa-onnx-c-api.dll")"
  sherpa_cxx_api_sha256="$(sha256_file "${speaker_native_directory}/sherpa-onnx-cxx-api.dll")"
  manifest="$(mktemp "${SIDECAR_STAGE_DIRECTORY}/.stage-manifest.XXXXXX")"
  cat >"${manifest}" <<EOF
{
  "schemaVersion": 1,
  "target": {
    "platform": "win32",
    "architecture": "x64"
  },
  "whisperCpp": {
    "version": "${WHISPER_CPP_VERSION}",
    "commit": "${WHISPER_CPP_COMMIT}",
    "binary": "whisper-cli.exe",
    "binarySha256": "${whisper_sha256}",
    "staticProjectLibraries": true,
    "ggmlBlas": false,
    "nativeHostTuning": false,
    "cpuBaseline": "avx2-fma-f16c",
    "cpuFeatures": ["sse4.2", "avx", "avx2", "bmi2", "f16c", "fma"],
    "gpuBackend": false
  },
  "ffmpeg": {
    "version": "${FFMPEG_VERSION}",
    "sourceArchiveSha256": "${FFMPEG_ARCHIVE_SHA256}",
    "binary": "ffmpeg.exe",
    "binarySha256": "${ffmpeg_sha256}",
    "license": "LGPL-2.1-or-later",
    "network": false
  },
  "model": {
    "name": "ggml-large-v3-turbo",
    "revision": "${MODEL_REVISION}",
    "file": "../../models/${MODEL_NAME}",
    "sha256": "${MODEL_SHA256}",
    "language": "Multilingual"
  },
  "speakerDiarization": {
    "runtime": "sherpa-onnx-node",
    "nativePackage": "sherpa-onnx-win-x64",
    "version": "${SHERPA_ONNX_VERSION}",
    "onnxRuntimeVersion": "${ONNXRUNTIME_VERSION}",
    "nativeBinaries": {
      "sherpa-onnx.node": "${sherpa_addon_sha256}",
      "onnxruntime.dll": "${onnxruntime_sha256}",
      "onnxruntime_providers_shared.dll": "${onnxruntime_providers_sha256}",
      "sherpa-onnx-c-api.dll": "${sherpa_c_api_sha256}",
      "sherpa-onnx-cxx-api.dll": "${sherpa_cxx_api_sha256}"
    },
    "segmentationModel": "../../diarization/${PYANNOTE_MODEL_NAME}",
    "segmentationModelSha256": "${PYANNOTE_MODEL_SHA256}",
    "embeddingModel": "../../diarization/${SPEAKER_EMBEDDING_MODEL_NAME}",
    "embeddingModelSha256": "${SPEAKER_EMBEDDING_MODEL_SHA256}"
  }
}
EOF
  mv -f -- "${manifest}" "${RUNTIME_MANIFEST_PATH}"
}

verify_staged_runtime() {
  local ffmpeg_sha256
  local native_binary
  local native_binary_sha256
  local speaker_native_directory="${SPEAKER_RUNTIME_STAGE_DIRECTORY}/sherpa-onnx-win-x64"
  local whisper_sha256

  require_command file
  require_command grep
  require_command awk
  verify_pe_x64 "${SIDECAR_STAGE_DIRECTORY}/whisper-cli.exe" 'staged whisper-cli.exe'
  verify_pe_x64 "${SIDECAR_STAGE_DIRECTORY}/ffmpeg.exe" 'staged ffmpeg.exe'
  verify_static_project_dependencies \
    "${SIDECAR_STAGE_DIRECTORY}/whisper-cli.exe" \
    'staged whisper-cli.exe'
  verify_static_project_dependencies \
    "${SIDECAR_STAGE_DIRECTORY}/ffmpeg.exe" \
    'staged ffmpeg.exe'
  if pe_objdump -p "${SIDECAR_STAGE_DIRECTORY}/ffmpeg.exe" | grep -Fiq 'ws2_32.dll'; then
    fail 'The staged ffmpeg.exe imports the Windows networking library.'
  fi
  verify_digest sha256 "${MODEL_STAGE_PATH}" "${MODEL_SHA256}" "staged ${MODEL_NAME} model"
  verify_digest sha256 "${PYANNOTE_MODEL_STAGE_PATH}" "${PYANNOTE_MODEL_SHA256}" 'staged Pyannote model'
  verify_digest \
    sha256 \
    "${SPEAKER_EMBEDDING_MODEL_STAGE_PATH}" \
    "${SPEAKER_EMBEDDING_MODEL_SHA256}" \
    'staged 3D-Speaker model'
  [[ -f "${SPEAKER_RUNTIME_STAGE_DIRECTORY}/sherpa-onnx-node/sherpa-onnx.js" ]] || fail \
    'The staged sherpa JavaScript package is missing.'
  verify_speaker_runtime
  verify_digest \
    sha256 \
    "${SHARED_LICENSE_STAGE_DIRECTORY}/sherpa-onnx.Apache-2.0.LICENSE" \
    "${SHERPA_LICENSE_SHA256}" \
    'staged sherpa-onnx Apache-2.0 license'
  verify_digest \
    sha256 \
    "${SHARED_LICENSE_STAGE_DIRECTORY}/3D-Speaker.Apache-2.0.LICENSE" \
    "${SHERPA_LICENSE_SHA256}" \
    'staged 3D-Speaker Apache-2.0 license'
  verify_digest \
    sha256 \
    "${SHARED_LICENSE_STAGE_DIRECTORY}/onnxruntime.LICENSE" \
    "${ONNXRUNTIME_LICENSE_SHA256}" \
    'staged ONNX Runtime license'
  verify_digest \
    sha256 \
    "${SHARED_LICENSE_STAGE_DIRECTORY}/onnxruntime.ThirdPartyNotices.txt" \
    "${ONNXRUNTIME_NOTICES_SHA256}" \
    'staged ONNX Runtime third-party notices'
  [[ -f "${RUNTIME_MANIFEST_PATH}" ]] || fail 'The Windows runtime manifest is missing.'

  whisper_sha256="$(sha256_file "${SIDECAR_STAGE_DIRECTORY}/whisper-cli.exe")"
  ffmpeg_sha256="$(sha256_file "${SIDECAR_STAGE_DIRECTORY}/ffmpeg.exe")"
  grep -Fq '"platform": "win32"' "${RUNTIME_MANIFEST_PATH}" || fail 'The manifest target is not win32.'
  grep -Fq '"architecture": "x64"' "${RUNTIME_MANIFEST_PATH}" || fail 'The manifest target is not x64.'
  grep -Fq '"cpuBaseline": "avx2-fma-f16c"' "${RUNTIME_MANIFEST_PATH}" || fail \
    'The manifest does not record the required Windows CPU baseline.'
  grep -Fq '"gpuBackend": false' "${RUNTIME_MANIFEST_PATH}" || fail \
    'The manifest does not record the CPU-only Whisper backend.'
  grep -Fq "\"binarySha256\": \"${whisper_sha256}\"" "${RUNTIME_MANIFEST_PATH}" || fail \
    'The manifest whisper-cli.exe checksum is stale.'
  grep -Fq "\"binarySha256\": \"${ffmpeg_sha256}\"" "${RUNTIME_MANIFEST_PATH}" || fail \
    'The manifest ffmpeg.exe checksum is stale.'
  for native_binary in \
    'sherpa-onnx.node' \
    'onnxruntime.dll' \
    'onnxruntime_providers_shared.dll' \
    'sherpa-onnx-c-api.dll' \
    'sherpa-onnx-cxx-api.dll'; do
    native_binary_sha256="$(sha256_file "${speaker_native_directory}/${native_binary}")"
    grep -Fq "\"${native_binary}\": \"${native_binary_sha256}\"" "${RUNTIME_MANIFEST_PATH}" || fail \
      "The manifest ${native_binary} checksum is stale."
  done
  grep -Fq '"network": false' "${RUNTIME_MANIFEST_PATH}" || fail 'The manifest does not disable FFmpeg networking.'

  log 'Verified the staged Windows x64 runtime.'
  log "  whisper-cli.exe SHA-256: ${whisper_sha256}"
  log "  ffmpeg.exe SHA-256:       ${ffmpeg_sha256}"
}

install_container_toolchain() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends \
    binutils-mingw-w64-x86-64 \
    build-essential \
    bzip2 \
    ca-certificates \
    cmake \
    curl \
    diffutils \
    file \
    g++-mingw-w64-x86-64 \
    gcc-mingw-w64-x86-64 \
    git \
    make \
    nasm \
    pkg-config \
    tar \
    xz-utils \
    yasm
}

container_build() {
  install_container_toolchain
  BUILD_JOBS="${SOTTO_BUILD_JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf '4')}"
  [[ "${BUILD_JOBS}" =~ ^[1-9][0-9]*$ ]] || fail 'SOTTO_BUILD_JOBS must be a positive integer.'
  readonly BUILD_JOBS

  mkdir -p \
    "${DOWNLOAD_DIRECTORY}" \
    "${SOURCE_DIRECTORY}" \
    "${BUILD_DIRECTORY}" \
    "${TEMPORARY_DIRECTORY}" \
    "${SIDECAR_STAGE_DIRECTORY}" \
    "${MODEL_STAGE_DIRECTORY}" \
    "${DIARIZATION_STAGE_DIRECTORY}" \
    "${LICENSE_STAGE_DIRECTORY}" \
    "${SHARED_LICENSE_STAGE_DIRECTORY}"
  prepare_whisper_source
  prepare_ffmpeg_source
  build_whisper_cli
  build_ffmpeg
  stage_shared_models
  stage_speaker_runtime
  stage_runtime_licenses

  log 'Staging verified Windows executables and license material.'
  stage_file \
    "${WHISPER_BUILD_DIRECTORY}/bin/whisper-cli.exe" \
    "${SIDECAR_STAGE_DIRECTORY}/whisper-cli.exe" \
    0755
  stage_file \
    "${FFMPEG_BUILD_DIRECTORY}/ffmpeg.exe" \
    "${SIDECAR_STAGE_DIRECTORY}/ffmpeg.exe" \
    0755
  stage_file "${WHISPER_SOURCE_DIRECTORY}/LICENSE" "${LICENSE_STAGE_DIRECTORY}/whisper.cpp.LICENSE" 0644
  stage_file "${FFMPEG_SOURCE_DIRECTORY}/LICENSE.md" "${LICENSE_STAGE_DIRECTORY}/FFmpeg.LICENSE.md" 0644
  stage_file \
    "${FFMPEG_SOURCE_DIRECTORY}/COPYING.LGPLv2.1" \
    "${LICENSE_STAGE_DIRECTORY}/FFmpeg.COPYING.LGPLv2.1" \
    0644
  stage_file \
    "${FFMPEG_SOURCE_DIRECTORY}/COPYING.LGPLv3" \
    "${LICENSE_STAGE_DIRECTORY}/FFmpeg.COPYING.LGPLv3" \
    0644
  stage_file \
    "${REPOSITORY_ROOT}/resources/sidecars/licenses/openai-whisper-model.LICENSE" \
    "${LICENSE_STAGE_DIRECTORY}/openai-whisper-model.LICENSE" \
    0644
  stage_file \
    "${REPOSITORY_ROOT}/resources/sidecars/licenses/pyannote-segmentation-3.0.LICENSE" \
    "${LICENSE_STAGE_DIRECTORY}/pyannote-segmentation-3.0.LICENSE" \
    0644
  write_runtime_manifest
  verify_staged_runtime
}

run_container_build() {
  require_command docker
  mkdir -p "${RUNTIME_BUILD_ROOT}"
  log 'Starting the pinned Linux cross-build container.'
  docker run \
    --rm \
    --mount "type=bind,source=${REPOSITORY_ROOT},target=/workspace" \
    --workdir /workspace \
    --env "SOTTO_BUILD_JOBS=${SOTTO_BUILD_JOBS:-}" \
    "${BUILD_IMAGE}" \
    bash scripts/provision-win32-x64.sh --container-build
  verify_staged_runtime
}

print_usage() {
  cat <<'EOF'
Usage: scripts/provision-win32-x64.sh [--verify-only]

With no arguments, use a pinned Debian container and MinGW to build the pinned
Windows x64 runtime, stage shared models and the Windows speaker package, and
write a runtime manifest. Docker must already be running.

  --verify-only  Validate staged PE binaries, models, speaker runtime, and the
                 manifest without network, Docker, builds, or filesystem writes.
  --help         Show this help text.
EOF
}

main() {
  case "${1:-}" in
    '')
      run_container_build
      ;;
    --container-build)
      [[ "$(id -u)" == '0' ]] || fail 'The internal container build must run as root.'
      container_build
      ;;
    --verify-only)
      verify_staged_runtime
      ;;
    --help)
      print_usage
      ;;
    *)
      fail "Unknown argument: $1 (use --help for usage)"
      ;;
  esac
}

BUILD_JOBS=''

main "$@"
