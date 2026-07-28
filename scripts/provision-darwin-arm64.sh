#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
LC_ALL=C

readonly WHISPER_CPP_VERSION='v1.9.1'
readonly WHISPER_CPP_COMMIT='f049fff95a089aa9969deb009cdd4892b3e74916'
readonly WHISPER_CPP_URL='https://github.com/ggml-org/whisper.cpp.git'

readonly FFMPEG_VERSION='8.1.2'
readonly FFMPEG_ARCHIVE_SHA256='464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c'
readonly FFMPEG_ARCHIVE_URL="https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"

readonly MODEL_NAME='ggml-small.en.bin'
readonly MODEL_SHA256='c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d'
readonly MODEL_REVISION='c521a4b02f422512d734391fdf08bb08c0862f68'
readonly MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/${MODEL_REVISION}/${MODEL_NAME}?download=true"

readonly SHERPA_ONNX_VERSION='1.13.4'
readonly PYANNOTE_ARCHIVE_NAME='sherpa-onnx-pyannote-segmentation-3-0.tar.bz2'
readonly PYANNOTE_ARCHIVE_SHA256='24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488'
readonly PYANNOTE_ARCHIVE_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/${PYANNOTE_ARCHIVE_NAME}"
readonly PYANNOTE_ARCHIVE_MODEL_PATH='sherpa-onnx-pyannote-segmentation-3-0/model.onnx'
readonly PYANNOTE_MODEL_NAME='pyannote-segmentation-3.0.onnx'
readonly PYANNOTE_MODEL_SHA256='220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079'
readonly SPEAKER_EMBEDDING_MODEL_NAME='3dspeaker-eres2net-base.onnx'
readonly SPEAKER_EMBEDDING_MODEL_SHA256='1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b'
readonly SPEAKER_EMBEDDING_MODEL_URL='https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx'

readonly MACOS_DEPLOYMENT_TARGET='12.0'

SCRIPT_DIRECTORY="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
readonly SCRIPT_DIRECTORY
REPOSITORY_ROOT="$(CDPATH='' cd -- "${SCRIPT_DIRECTORY}/.." && pwd)"
readonly REPOSITORY_ROOT

readonly RUNTIME_BUILD_ROOT="${REPOSITORY_ROOT}/.build/runtime/darwin-arm64"
readonly DOWNLOAD_DIRECTORY="${RUNTIME_BUILD_ROOT}/downloads"
readonly SOURCE_DIRECTORY="${RUNTIME_BUILD_ROOT}/sources"
readonly BUILD_DIRECTORY="${RUNTIME_BUILD_ROOT}/build"
readonly WHISPER_SOURCE_DIRECTORY="${SOURCE_DIRECTORY}/whisper.cpp-${WHISPER_CPP_VERSION}"
readonly WHISPER_BUILD_DIRECTORY="${BUILD_DIRECTORY}/whisper.cpp-${WHISPER_CPP_VERSION}"
readonly FFMPEG_ARCHIVE_PATH="${DOWNLOAD_DIRECTORY}/ffmpeg-${FFMPEG_VERSION}.tar.xz"
readonly FFMPEG_SOURCE_DIRECTORY="${SOURCE_DIRECTORY}/ffmpeg-${FFMPEG_VERSION}"
readonly FFMPEG_BUILD_DIRECTORY="${BUILD_DIRECTORY}/ffmpeg-${FFMPEG_VERSION}"
readonly MODEL_CACHE_PATH="${DOWNLOAD_DIRECTORY}/${MODEL_NAME}"
readonly PYANNOTE_ARCHIVE_CACHE_PATH="${DOWNLOAD_DIRECTORY}/${PYANNOTE_ARCHIVE_NAME}"
readonly PYANNOTE_MODEL_CACHE_PATH="${DOWNLOAD_DIRECTORY}/${PYANNOTE_MODEL_NAME}"
readonly SPEAKER_EMBEDDING_MODEL_CACHE_PATH="${DOWNLOAD_DIRECTORY}/${SPEAKER_EMBEDDING_MODEL_NAME}"

readonly SIDECAR_STAGE_DIRECTORY="${REPOSITORY_ROOT}/resources/sidecars/darwin-arm64"
readonly MODEL_STAGE_DIRECTORY="${REPOSITORY_ROOT}/resources/models"
readonly MODEL_STAGE_PATH="${MODEL_STAGE_DIRECTORY}/${MODEL_NAME}"
readonly DIARIZATION_STAGE_DIRECTORY="${REPOSITORY_ROOT}/resources/diarization"
readonly PYANNOTE_MODEL_STAGE_PATH="${DIARIZATION_STAGE_DIRECTORY}/${PYANNOTE_MODEL_NAME}"
readonly SPEAKER_EMBEDDING_MODEL_STAGE_PATH="${DIARIZATION_STAGE_DIRECTORY}/${SPEAKER_EMBEDDING_MODEL_NAME}"
readonly SPEAKER_RUNTIME_STAGE_DIRECTORY="${REPOSITORY_ROOT}/resources/speaker-runtime"
readonly LICENSE_STAGE_DIRECTORY="${SIDECAR_STAGE_DIRECTORY}/licenses"
readonly RUNTIME_MANIFEST_PATH="${SIDECAR_STAGE_DIRECTORY}/runtime-manifest.json"

TEMPORARY_PATHS=()

log() {
  printf '[sotto-runtime] %s\n' "$*"
}

fail() {
  printf '[sotto-runtime] ERROR: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  local temporary_path

  for temporary_path in "${TEMPORARY_PATHS[@]:-}"; do
    [[ -e "${temporary_path}" ]] || continue

    case "${temporary_path}" in
      "${RUNTIME_BUILD_ROOT}"/temporary/* | "${SIDECAR_STAGE_DIRECTORY}"/.stage-* | "${MODEL_STAGE_DIRECTORY}"/.stage-* | "${DIARIZATION_STAGE_DIRECTORY}"/.stage-*)
        rm -rf -- "${temporary_path}"
        ;;
      *)
        printf '[sotto-runtime] Refusing to remove unexpected temporary path: %s\n' "${temporary_path}" >&2
        ;;
    esac
  done
}

trap cleanup EXIT INT TERM

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command is unavailable: $1"
}

sha256_file() {
  shasum -a 256 -- "$1" | awk '{print $1}'
}

verify_sha256() {
  local path="$1"
  local expected_sha256="$2"
  local label="$3"
  local actual_sha256

  [[ -f "${path}" ]] || fail "${label} is missing: ${path}"
  actual_sha256="$(sha256_file "${path}")"

  if [[ "${actual_sha256}" != "${expected_sha256}" ]]; then
    fail "${label} checksum mismatch (expected ${expected_sha256}, got ${actual_sha256}): ${path}"
  fi
}

download_verified_file() {
  local url="$1"
  local expected_sha256="$2"
  local destination="$3"
  local label="$4"
  local temporary_download

  if [[ -e "${destination}" ]]; then
    verify_sha256 "${destination}" "${expected_sha256}" "${label}"
    log "Using verified cached ${label}."
    return
  fi

  temporary_download="$(mktemp "${RUNTIME_BUILD_ROOT}/temporary/download.XXXXXX")"
  TEMPORARY_PATHS+=("${temporary_download}")

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

  verify_sha256 "${temporary_download}" "${expected_sha256}" "${label}"
  mv -- "${temporary_download}" "${destination}"
}

assert_clean_git_source() {
  local source_path="$1"

  if [[ -n "$(git -C "${source_path}" status --porcelain --untracked-files=normal)" ]]; then
    fail "The cached whisper.cpp source has local changes. Move it aside and rerun: ${source_path}"
  fi
}

prepare_whisper_source() {
  local origin_url
  local tag_commit
  local checked_out_commit

  if [[ ! -e "${WHISPER_SOURCE_DIRECTORY}" ]]; then
    log "Cloning whisper.cpp ${WHISPER_CPP_VERSION}."
    git clone \
      --branch "${WHISPER_CPP_VERSION}" \
      --depth=1 \
      --filter=blob:none \
      "${WHISPER_CPP_URL}" \
      "${WHISPER_SOURCE_DIRECTORY}"
  elif [[ ! -d "${WHISPER_SOURCE_DIRECTORY}/.git" ]]; then
    fail "Expected a Git checkout at ${WHISPER_SOURCE_DIRECTORY}; move the unexpected path aside and rerun."
  fi

  origin_url="$(git -C "${WHISPER_SOURCE_DIRECTORY}" remote get-url origin)"
  [[ "${origin_url}" == "${WHISPER_CPP_URL}" ]] || fail "Unexpected whisper.cpp origin: ${origin_url}"

  assert_clean_git_source "${WHISPER_SOURCE_DIRECTORY}"

  if ! git -C "${WHISPER_SOURCE_DIRECTORY}" show-ref --verify --quiet "refs/tags/${WHISPER_CPP_VERSION}"; then
    log "Fetching the pinned whisper.cpp tag."
    git -C "${WHISPER_SOURCE_DIRECTORY}" fetch --depth=1 origin \
      "refs/tags/${WHISPER_CPP_VERSION}:refs/tags/${WHISPER_CPP_VERSION}"
  fi

  tag_commit="$(git -C "${WHISPER_SOURCE_DIRECTORY}" rev-list -n 1 "refs/tags/${WHISPER_CPP_VERSION}")"
  [[ "${tag_commit}" == "${WHISPER_CPP_COMMIT}" ]] || fail \
    "whisper.cpp tag ${WHISPER_CPP_VERSION} resolves to ${tag_commit}, not pinned commit ${WHISPER_CPP_COMMIT}."

  checked_out_commit="$(git -C "${WHISPER_SOURCE_DIRECTORY}" rev-parse --verify HEAD 2>/dev/null || true)"
  if [[ "${checked_out_commit}" != "${WHISPER_CPP_COMMIT}" ]]; then
    log "Checking out pinned whisper.cpp commit ${WHISPER_CPP_COMMIT}."
    git -C "${WHISPER_SOURCE_DIRECTORY}" -c advice.detachedHead=false checkout --detach "${WHISPER_CPP_COMMIT}"
  fi

  assert_clean_git_source "${WHISPER_SOURCE_DIRECTORY}"
  checked_out_commit="$(git -C "${WHISPER_SOURCE_DIRECTORY}" rev-parse --verify HEAD)"
  [[ "${checked_out_commit}" == "${WHISPER_CPP_COMMIT}" ]] || fail "Failed to check out pinned whisper.cpp commit."
  [[ -f "${WHISPER_SOURCE_DIRECTORY}/CMakeLists.txt" && -f "${WHISPER_SOURCE_DIRECTORY}/LICENSE" ]] || fail \
    "The cached whisper.cpp worktree is incomplete. Move it aside and rerun: ${WHISPER_SOURCE_DIRECTORY}"
}

prepare_ffmpeg_source() {
  local extraction_directory
  local extracted_source

  download_verified_file \
    "${FFMPEG_ARCHIVE_URL}" \
    "${FFMPEG_ARCHIVE_SHA256}" \
    "${FFMPEG_ARCHIVE_PATH}" \
    "FFmpeg ${FFMPEG_VERSION} source archive"

  extraction_directory="$(mktemp -d "${RUNTIME_BUILD_ROOT}/temporary/ffmpeg-source.XXXXXX")"
  TEMPORARY_PATHS+=("${extraction_directory}")

  log "Extracting the verified FFmpeg source archive."
  tar -xJf "${FFMPEG_ARCHIVE_PATH}" -C "${extraction_directory}"
  extracted_source="${extraction_directory}/ffmpeg-${FFMPEG_VERSION}"
  [[ -x "${extracted_source}/configure" ]] || fail "The FFmpeg archive did not contain the expected source tree."

  if [[ -e "${FFMPEG_SOURCE_DIRECTORY}" ]]; then
    [[ -x "${FFMPEG_SOURCE_DIRECTORY}/configure" ]] || fail \
      "Cached FFmpeg source is incomplete. Move it aside and rerun: ${FFMPEG_SOURCE_DIRECTORY}"
    if ! diff -qr "${extracted_source}" "${FFMPEG_SOURCE_DIRECTORY}" >/dev/null; then
      fail "Cached FFmpeg source differs from the verified archive. Move it aside and rerun: ${FFMPEG_SOURCE_DIRECTORY}"
    fi
    return
  fi

  mv -- "${extracted_source}" "${FFMPEG_SOURCE_DIRECTORY}"
}

verify_arm64_macos_binary() {
  local binary_path="$1"
  local label="$2"
  local architectures
  local linked_libraries
  local minimum_version_output

  [[ -x "${binary_path}" ]] || fail "${label} was not built: ${binary_path}"

  architectures="$(lipo -archs "${binary_path}")"
  [[ "${architectures}" == 'arm64' ]] || fail "${label} architecture is '${architectures}', expected only arm64."

  linked_libraries="$(otool -L "${binary_path}")"
  if grep -Eq \
    '@rpath|@loader_path|/opt/homebrew|/usr/local|lib(avcodec|avdevice|avfilter|avformat|avutil|postproc|swresample|swscale|whisper|ggml)[^/]*\.dylib' \
    <<<"${linked_libraries}"; then
    printf '%s\n' "${linked_libraries}" >&2
    fail "${label} has an unexpected non-system or project-library dynamic dependency."
  fi

  minimum_version_output="$(xcrun vtool -show-build "${binary_path}")"
  if ! grep -Eq 'minos[[:space:]]+12\.0([[:space:]]|$)' <<<"${minimum_version_output}"; then
    printf '%s\n' "${minimum_version_output}" >&2
    fail "${label} does not declare macOS ${MACOS_DEPLOYMENT_TARGET} as its minimum deployment target."
  fi
}

verify_ffmpeg_runtime_identity() {
  local ffmpeg_binary="$1"
  local build_configuration
  local license_output

  "${ffmpeg_binary}" -hide_banner -version | grep -Fq "ffmpeg version ${FFMPEG_VERSION}" || fail \
    "The FFmpeg executable reported an unexpected version."
  build_configuration="$("${ffmpeg_binary}" -hide_banner -buildconf 2>&1)"
  grep -Fq -- '--disable-network' <<<"${build_configuration}" || fail \
    "The FFmpeg executable does not report --disable-network."
  grep -Fq -- '--enable-static' <<<"${build_configuration}" || fail \
    "The FFmpeg executable does not report --enable-static."
  grep -Fq -- '--disable-shared' <<<"${build_configuration}" || fail \
    "The FFmpeg executable does not report --disable-shared."
  if grep -Eq -- '--enable-(gpl|nonfree)([[:space:]]|$)' <<<"${build_configuration}"; then
    fail "The FFmpeg executable enables GPL or nonfree build components."
  fi

  license_output="$("${ffmpeg_binary}" -hide_banner -L 2>&1)"
  grep -Fq 'GNU Lesser General Public' <<<"${license_output}" || fail \
    "The FFmpeg executable does not report the expected LGPL license."
  grep -Fq 'version 2.1' <<<"${license_output}" || fail \
    "The FFmpeg executable does not report LGPL version 2.1-or-later."
}

verify_whisper_runtime_identity() {
  local whisper_binary="$1"
  local expected_version="${WHISPER_CPP_VERSION#v}"

  "${whisper_binary}" --version 2>&1 | grep -Fq "whisper.cpp version: ${expected_version}" || fail \
    "The whisper-cli executable reported an unexpected version."
}

build_whisper_cli() {
  local whisper_binary

  log "Configuring static whisper-cli for arm64 macOS ${MACOS_DEPLOYMENT_TARGET} with embedded Metal."
  cmake \
    -G 'Unix Makefiles' \
    -S "${WHISPER_SOURCE_DIRECTORY}" \
    -B "${WHISPER_BUILD_DIRECTORY}" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_COMPILER="$(xcrun --sdk macosx --find clang)" \
    -DCMAKE_CXX_COMPILER="$(xcrun --sdk macosx --find clang++)" \
    -DCMAKE_OSX_ARCHITECTURES=arm64 \
    -DCMAKE_OSX_DEPLOYMENT_TARGET="${MACOS_DEPLOYMENT_TARGET}" \
    -DCMAKE_OSX_SYSROOT="$(xcrun --sdk macosx --show-sdk-path)" \
    -DBUILD_SHARED_LIBS=OFF \
    -DGGML_BLAS=OFF \
    -DGGML_METAL=ON \
    -DGGML_METAL_EMBED_LIBRARY=ON \
    -DGGML_NATIVE=OFF \
    -DGGML_OPENMP=OFF \
    -DWHISPER_BUILD_BENCHMARKS=OFF \
    -DWHISPER_BUILD_EXAMPLES=ON \
    -DWHISPER_BUILD_SERVER=OFF \
    -DWHISPER_BUILD_TESTS=OFF \
    -DWHISPER_COREML=OFF \
    -DWHISPER_FFMPEG=OFF \
    -DWHISPER_OPENVINO=OFF \
    -DWHISPER_SDL2=OFF

  grep -Eq '^GGML_BLAS:BOOL=OFF$' "${WHISPER_BUILD_DIRECTORY}/CMakeCache.txt" || fail "GGML_BLAS was not disabled."
  grep -Eq '^GGML_METAL:BOOL=ON$' "${WHISPER_BUILD_DIRECTORY}/CMakeCache.txt" || fail "Metal was not enabled."
  grep -Eq '^GGML_METAL_EMBED_LIBRARY:BOOL=ON$' "${WHISPER_BUILD_DIRECTORY}/CMakeCache.txt" || fail \
    "The Metal library was not configured for embedding."
  grep -Eq '^BUILD_SHARED_LIBS:BOOL=OFF$' "${WHISPER_BUILD_DIRECTORY}/CMakeCache.txt" || fail \
    "Shared whisper.cpp project libraries were not disabled."

  log "Building whisper-cli with ${BUILD_JOBS} parallel jobs."
  cmake --build "${WHISPER_BUILD_DIRECTORY}" --config Release --parallel "${BUILD_JOBS}" --target whisper-cli

  whisper_binary="${WHISPER_BUILD_DIRECTORY}/bin/whisper-cli"
  verify_arm64_macos_binary "${whisper_binary}" 'whisper-cli'
  verify_whisper_runtime_identity "${whisper_binary}"
}

build_ffmpeg() {
  local configure_output="${FFMPEG_BUILD_DIRECTORY}/configure-output.txt"
  local ffmpeg_binary="${FFMPEG_BUILD_DIRECTORY}/ffmpeg"

  mkdir -p "${FFMPEG_BUILD_DIRECTORY}"

  log "Configuring minimal static LGPL FFmpeg for offline audio decoding."
  (
    cd -- "${FFMPEG_BUILD_DIRECTORY}"
    CC="$(xcrun --sdk macosx --find clang)" \
      MACOSX_DEPLOYMENT_TARGET="${MACOS_DEPLOYMENT_TARGET}" \
      "${FFMPEG_SOURCE_DIRECTORY}/configure" \
      --disable-everything \
      --disable-autodetect \
      --disable-network \
      --disable-doc \
      --disable-debug \
      --disable-ffplay \
      --disable-ffprobe \
      --enable-ffmpeg \
      --enable-static \
      --disable-shared \
      --enable-small \
      --enable-pthreads \
      --enable-protocol=file,pipe \
      --enable-demuxer=aac,asf,avi,flac,matroska,mov,mp3,mpegts,ogg,wav \
      --enable-decoder=aac,aac_fixed,alac,flac,mp3,mp3float,opus,vorbis,wavpack,wmav1,wmav2,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_f32le,pcm_f32be,pcm_u8,pcm_s8 \
      --enable-parser=aac,aac_latm,mpegaudio,opus,vorbis \
      --enable-encoder=pcm_s16le \
      --enable-muxer=wav \
      --enable-filter=anull,aformat,aresample \
      --extra-cflags=-mmacosx-version-min=12.0 \
      --extra-ldflags=-mmacosx-version-min=12.0 \
      2>&1 | tee "${configure_output}"
  )

  grep -Eq '^License:[[:space:]]+LGPL version 2\.1 or later$' "${configure_output}" || fail \
    "FFmpeg did not report the required LGPL 2.1-or-later license."
  grep -Eq '^network support[[:space:]]+no$' "${configure_output}" || fail \
    "FFmpeg did not report that network support is disabled."

  log "Building FFmpeg with ${BUILD_JOBS} parallel jobs."
  make -C "${FFMPEG_BUILD_DIRECTORY}" -j "${BUILD_JOBS}" ffmpeg

  verify_arm64_macos_binary "${ffmpeg_binary}" 'ffmpeg'
  verify_ffmpeg_runtime_identity "${ffmpeg_binary}"
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
  TEMPORARY_PATHS+=("${temporary_stage}")
  install -m "${mode}" "${source_path}" "${temporary_stage}"
  mv -f -- "${temporary_stage}" "${destination_path}"
}

stage_model() {
  if [[ -e "${MODEL_STAGE_PATH}" ]]; then
    verify_sha256 "${MODEL_STAGE_PATH}" "${MODEL_SHA256}" "staged ${MODEL_NAME} model"
    log "The staged model is already present and verified."
    return
  fi

  download_verified_file "${MODEL_URL}" "${MODEL_SHA256}" "${MODEL_CACHE_PATH}" "${MODEL_NAME} model"

  log "Staging the verified ${MODEL_NAME} model."
  stage_file "${MODEL_CACHE_PATH}" "${MODEL_STAGE_PATH}" 0644
  verify_sha256 "${MODEL_STAGE_PATH}" "${MODEL_SHA256}" "staged ${MODEL_NAME} model"
}

stage_speaker_models() {
  local temporary_model

  download_verified_file \
    "${PYANNOTE_ARCHIVE_URL}" \
    "${PYANNOTE_ARCHIVE_SHA256}" \
    "${PYANNOTE_ARCHIVE_CACHE_PATH}" \
    'Pyannote speaker-segmentation archive'

  if [[ ! -e "${PYANNOTE_MODEL_CACHE_PATH}" ]]; then
    temporary_model="$(mktemp "${RUNTIME_BUILD_ROOT}/temporary/pyannote-model.XXXXXX")"
    TEMPORARY_PATHS+=("${temporary_model}")
    tar -xOf "${PYANNOTE_ARCHIVE_CACHE_PATH}" "${PYANNOTE_ARCHIVE_MODEL_PATH}" >"${temporary_model}"
    verify_sha256 "${temporary_model}" "${PYANNOTE_MODEL_SHA256}" 'extracted Pyannote model'
    mv -- "${temporary_model}" "${PYANNOTE_MODEL_CACHE_PATH}"
  fi

  download_verified_file \
    "${SPEAKER_EMBEDDING_MODEL_URL}" \
    "${SPEAKER_EMBEDDING_MODEL_SHA256}" \
    "${SPEAKER_EMBEDDING_MODEL_CACHE_PATH}" \
    '3D-Speaker embedding model'

  stage_file "${PYANNOTE_MODEL_CACHE_PATH}" "${PYANNOTE_MODEL_STAGE_PATH}" 0644
  stage_file \
    "${SPEAKER_EMBEDDING_MODEL_CACHE_PATH}" \
    "${SPEAKER_EMBEDDING_MODEL_STAGE_PATH}" \
    0644
  verify_sha256 "${PYANNOTE_MODEL_STAGE_PATH}" "${PYANNOTE_MODEL_SHA256}" 'staged Pyannote model'
  verify_sha256 \
    "${SPEAKER_EMBEDDING_MODEL_STAGE_PATH}" \
    "${SPEAKER_EMBEDDING_MODEL_SHA256}" \
    'staged 3D-Speaker model'
}

stage_speaker_runtime() {
  local node_package="${REPOSITORY_ROOT}/node_modules/sherpa-onnx-node"
  local native_package="${REPOSITORY_ROOT}/node_modules/sherpa-onnx-darwin-arm64"
  local temporary_runtime

  [[ -f "${node_package}/sherpa-onnx.js" ]] || fail 'Run npm install before staging the speaker runtime.'
  [[ -f "${native_package}/sherpa-onnx.node" ]] || fail 'The arm64 sherpa-onnx optional package is missing.'
  grep -Fq "\"version\": \"${SHERPA_ONNX_VERSION}\"" "${node_package}/package.json" || fail \
    'The installed sherpa-onnx-node version does not match the pinned runtime version.'
  grep -Fq "\"version\": \"${SHERPA_ONNX_VERSION}\"" "${native_package}/package.json" || fail \
    'The installed native sherpa-onnx version does not match the pinned runtime version.'

  temporary_runtime="$(mktemp -d "${RUNTIME_BUILD_ROOT}/temporary/speaker-runtime.XXXXXX")"
  TEMPORARY_PATHS+=("${temporary_runtime}")
  cp -R "${node_package}" "${temporary_runtime}/sherpa-onnx-node"
  cp -R "${native_package}" "${temporary_runtime}/sherpa-onnx-darwin-arm64"

  rm -rf -- "${SPEAKER_RUNTIME_STAGE_DIRECTORY}"
  mv -- "${temporary_runtime}" "${SPEAKER_RUNTIME_STAGE_DIRECTORY}"
  [[ "$(lipo -archs "${SPEAKER_RUNTIME_STAGE_DIRECTORY}/sherpa-onnx-darwin-arm64/sherpa-onnx.node")" == 'arm64' ]] || fail \
    'The staged sherpa-onnx native addon is not arm64.'
}

write_runtime_manifest() {
  local whisper_binary_sha256
  local ffmpeg_binary_sha256
  local temporary_manifest

  whisper_binary_sha256="$(sha256_file "${SIDECAR_STAGE_DIRECTORY}/whisper-cli")"
  ffmpeg_binary_sha256="$(sha256_file "${SIDECAR_STAGE_DIRECTORY}/ffmpeg")"
  temporary_manifest="$(mktemp "${SIDECAR_STAGE_DIRECTORY}/.stage-manifest.XXXXXX")"
  TEMPORARY_PATHS+=("${temporary_manifest}")

  cat >"${temporary_manifest}" <<EOF
{
  "schemaVersion": 1,
  "target": {
    "platform": "darwin",
    "architecture": "arm64",
    "minimumMacOSVersion": "${MACOS_DEPLOYMENT_TARGET}"
  },
  "whisperCpp": {
    "version": "${WHISPER_CPP_VERSION}",
    "commit": "${WHISPER_CPP_COMMIT}",
    "binary": "whisper-cli",
    "binarySha256": "${whisper_binary_sha256}",
    "staticProjectLibraries": true,
    "metal": "embedded",
    "ggmlBlas": false
  },
  "ffmpeg": {
    "version": "${FFMPEG_VERSION}",
    "sourceArchiveSha256": "${FFMPEG_ARCHIVE_SHA256}",
    "binary": "ffmpeg",
    "binarySha256": "${ffmpeg_binary_sha256}",
    "license": "LGPL-2.1-or-later",
    "network": false
  },
  "model": {
    "name": "ggml-small.en",
    "revision": "${MODEL_REVISION}",
    "file": "../../models/${MODEL_NAME}",
    "sha256": "${MODEL_SHA256}",
    "language": "English"
  },
  "speakerDiarization": {
    "runtime": "sherpa-onnx-node",
    "version": "${SHERPA_ONNX_VERSION}",
    "segmentationModel": "../../diarization/${PYANNOTE_MODEL_NAME}",
    "segmentationModelSha256": "${PYANNOTE_MODEL_SHA256}",
    "embeddingModel": "../../diarization/${SPEAKER_EMBEDDING_MODEL_NAME}",
    "embeddingModelSha256": "${SPEAKER_EMBEDDING_MODEL_SHA256}",
    "minimumMacOSVersion": "15.5"
  }
}
EOF

  mv -f -- "${temporary_manifest}" "${RUNTIME_MANIFEST_PATH}"
}

validate_host() {
  local host_system
  local host_architecture

  host_system="$(uname -s)"
  host_architecture="$(uname -m)"

  [[ "${host_system}" == 'Darwin' ]] || fail "This provisioning script only supports macOS; detected ${host_system}."
  [[ "${host_architecture}" == 'arm64' ]] || fail \
    "Run this script in a native arm64 shell on Apple Silicon; detected ${host_architecture}."

  require_command awk
  require_command grep
  require_command lipo
  require_command otool
  require_command shasum
  require_command xcrun

  xcrun --find vtool >/dev/null 2>&1 || fail "vtool is unavailable in the active Xcode toolchain."
}

validate_build_toolchain() {
  require_command cmake
  require_command curl
  require_command diff
  require_command git
  require_command install
  require_command make
  require_command mktemp
  require_command tar

  xcrun --sdk macosx --find clang >/dev/null 2>&1 || fail "The macOS clang toolchain is unavailable."
  xcrun --sdk macosx --find clang++ >/dev/null 2>&1 || fail "The macOS clang++ toolchain is unavailable."
  xcrun --sdk macosx --find metal >/dev/null 2>&1 || fail \
    "The Metal compiler is unavailable. Install Xcode and its Metal toolchain."
  xcrun --sdk macosx --find metallib >/dev/null 2>&1 || fail \
    "The Metal library tool is unavailable. Install Xcode and its Metal toolchain."
}

resolve_build_jobs() {
  local requested_jobs="${SOTTO_BUILD_JOBS:-}"

  if [[ -z "${requested_jobs}" ]]; then
    requested_jobs="$(sysctl -n hw.logicalcpu 2>/dev/null || printf '4')"
  fi

  [[ "${requested_jobs}" =~ ^[1-9][0-9]*$ ]] || fail \
    "SOTTO_BUILD_JOBS must be a positive integer; received '${requested_jobs}'."
  printf '%s' "${requested_jobs}"
}

print_usage() {
  cat <<'EOF'
Usage: scripts/provision-darwin-arm64.sh [--verify-only]

With no arguments, download verified sources/model inputs, build the pinned
runtime, stage it under resources/, and write its runtime manifest.

  --verify-only  Validate the already-staged binaries and model without network,
                 downloads, builds, or filesystem changes.
  --help         Show this help text.
EOF
}

verify_staged_runtime() {
  local whisper_sha256
  local ffmpeg_sha256

  verify_arm64_macos_binary "${SIDECAR_STAGE_DIRECTORY}/whisper-cli" 'staged whisper-cli'
  verify_arm64_macos_binary "${SIDECAR_STAGE_DIRECTORY}/ffmpeg" 'staged ffmpeg'
  verify_whisper_runtime_identity "${SIDECAR_STAGE_DIRECTORY}/whisper-cli"
  verify_ffmpeg_runtime_identity "${SIDECAR_STAGE_DIRECTORY}/ffmpeg"
  verify_sha256 "${MODEL_STAGE_PATH}" "${MODEL_SHA256}" "staged ${MODEL_NAME} model"
  verify_sha256 "${PYANNOTE_MODEL_STAGE_PATH}" "${PYANNOTE_MODEL_SHA256}" 'staged Pyannote model'
  verify_sha256 \
    "${SPEAKER_EMBEDDING_MODEL_STAGE_PATH}" \
    "${SPEAKER_EMBEDDING_MODEL_SHA256}" \
    'staged 3D-Speaker model'
  [[ "$(lipo -archs "${SPEAKER_RUNTIME_STAGE_DIRECTORY}/sherpa-onnx-darwin-arm64/sherpa-onnx.node")" == 'arm64' ]] || fail \
    'The staged sherpa-onnx native addon is not arm64.'
  [[ -f "${SPEAKER_RUNTIME_STAGE_DIRECTORY}/sherpa-onnx-node/sherpa-onnx.js" ]] || fail \
    'The staged sherpa-onnx JavaScript module is missing.'

  whisper_sha256="$(sha256_file "${SIDECAR_STAGE_DIRECTORY}/whisper-cli")"
  ffmpeg_sha256="$(sha256_file "${SIDECAR_STAGE_DIRECTORY}/ffmpeg")"

  [[ -f "${RUNTIME_MANIFEST_PATH}" ]] || fail "The staged runtime manifest is missing: ${RUNTIME_MANIFEST_PATH}"
  grep -Fq '"binary": "whisper-cli"' "${RUNTIME_MANIFEST_PATH}" || fail \
    "The runtime manifest does not name whisper-cli."
  grep -Fq '"binary": "ffmpeg"' "${RUNTIME_MANIFEST_PATH}" || fail \
    "The runtime manifest does not name ffmpeg."
  grep -Fq '"file": "../../models/ggml-small.en.bin"' "${RUNTIME_MANIFEST_PATH}" || fail \
    "The runtime manifest does not name the staged model path."
  grep -Fq "\"binarySha256\": \"${whisper_sha256}\"" "${RUNTIME_MANIFEST_PATH}" || fail \
    "The runtime manifest whisper-cli checksum does not match the staged executable."
  grep -Fq "\"binarySha256\": \"${ffmpeg_sha256}\"" "${RUNTIME_MANIFEST_PATH}" || fail \
    "The runtime manifest FFmpeg checksum does not match the staged executable."
  grep -Fq "\"sha256\": \"${MODEL_SHA256}\"" "${RUNTIME_MANIFEST_PATH}" || fail \
    "The runtime manifest model checksum is incorrect."
  grep -Fq "\"segmentationModelSha256\": \"${PYANNOTE_MODEL_SHA256}\"" "${RUNTIME_MANIFEST_PATH}" || fail \
    'The runtime manifest Pyannote checksum is incorrect.'
  grep -Fq "\"embeddingModelSha256\": \"${SPEAKER_EMBEDDING_MODEL_SHA256}\"" "${RUNTIME_MANIFEST_PATH}" || fail \
    'The runtime manifest 3D-Speaker checksum is incorrect.'

  log "Verified the staged runtime without modifying it."
  log "  whisper-cli SHA-256: ${whisper_sha256}"
  log "  ffmpeg SHA-256:       ${ffmpeg_sha256}"
  log "  model SHA-256:        ${MODEL_SHA256}"
  log "  Pyannote SHA-256:     ${PYANNOTE_MODEL_SHA256}"
  log "  3D-Speaker SHA-256:   ${SPEAKER_EMBEDDING_MODEL_SHA256}"
}

main() {
  local mode='provision'

  if [[ "${1:-}" == '--help' ]]; then
    print_usage
    return
  fi

  if [[ "${1:-}" == '--verify-only' ]]; then
    mode='verify-only'
    shift
  fi

  [[ "$#" -eq 0 ]] || fail "Unknown argument: $1 (use --help for usage)"

  validate_host

  if [[ "${mode}" == 'verify-only' ]]; then
    verify_staged_runtime
    return
  fi

  validate_build_toolchain
  BUILD_JOBS="$(resolve_build_jobs)"
  readonly BUILD_JOBS

  mkdir -p \
    "${DOWNLOAD_DIRECTORY}" \
    "${SOURCE_DIRECTORY}" \
    "${BUILD_DIRECTORY}" \
    "${RUNTIME_BUILD_ROOT}/temporary" \
    "${SIDECAR_STAGE_DIRECTORY}" \
    "${MODEL_STAGE_DIRECTORY}" \
    "${DIARIZATION_STAGE_DIRECTORY}" \
    "${LICENSE_STAGE_DIRECTORY}"

  prepare_whisper_source
  prepare_ffmpeg_source
  build_whisper_cli
  build_ffmpeg
  stage_model
  stage_speaker_models
  stage_speaker_runtime

  log "Staging verified runtime executables and license material."
  stage_file "${WHISPER_BUILD_DIRECTORY}/bin/whisper-cli" "${SIDECAR_STAGE_DIRECTORY}/whisper-cli" 0755
  stage_file "${FFMPEG_BUILD_DIRECTORY}/ffmpeg" "${SIDECAR_STAGE_DIRECTORY}/ffmpeg" 0755
  stage_file "${WHISPER_SOURCE_DIRECTORY}/LICENSE" "${LICENSE_STAGE_DIRECTORY}/whisper.cpp.LICENSE" 0644
  stage_file "${FFMPEG_SOURCE_DIRECTORY}/LICENSE.md" "${LICENSE_STAGE_DIRECTORY}/FFmpeg.LICENSE.md" 0644
  stage_file "${FFMPEG_SOURCE_DIRECTORY}/COPYING.LGPLv2.1" "${LICENSE_STAGE_DIRECTORY}/FFmpeg.COPYING.LGPLv2.1" 0644
  stage_file "${FFMPEG_SOURCE_DIRECTORY}/COPYING.LGPLv3" "${LICENSE_STAGE_DIRECTORY}/FFmpeg.COPYING.LGPLv3" 0644
  stage_file \
    "${REPOSITORY_ROOT}/resources/sidecars/licenses/openai-whisper-model.LICENSE" \
    "${LICENSE_STAGE_DIRECTORY}/openai-whisper-model.LICENSE" \
    0644
  stage_file \
    "${REPOSITORY_ROOT}/resources/sidecars/licenses/pyannote-segmentation-3.0.LICENSE" \
    "${LICENSE_STAGE_DIRECTORY}/pyannote-segmentation-3.0.LICENSE" \
    0644

  verify_sha256 "${MODEL_STAGE_PATH}" "${MODEL_SHA256}" "staged ${MODEL_NAME} model"
  verify_arm64_macos_binary "${SIDECAR_STAGE_DIRECTORY}/whisper-cli" 'staged whisper-cli'
  verify_arm64_macos_binary "${SIDECAR_STAGE_DIRECTORY}/ffmpeg" 'staged ffmpeg'
  verify_whisper_runtime_identity "${SIDECAR_STAGE_DIRECTORY}/whisper-cli"
  verify_ffmpeg_runtime_identity "${SIDECAR_STAGE_DIRECTORY}/ffmpeg"
  write_runtime_manifest

  log "Provisioning complete."
  log "  whisper-cli: ${SIDECAR_STAGE_DIRECTORY}/whisper-cli"
  log "  ffmpeg:       ${SIDECAR_STAGE_DIRECTORY}/ffmpeg"
  log "  model:        ${MODEL_STAGE_PATH}"
  log "  speaker models: ${DIARIZATION_STAGE_DIRECTORY}"
  log "  speaker runtime: ${SPEAKER_RUNTIME_STAGE_DIRECTORY}"
  log "  manifest:     ${RUNTIME_MANIFEST_PATH}"
}

BUILD_JOBS=''

main "$@"
