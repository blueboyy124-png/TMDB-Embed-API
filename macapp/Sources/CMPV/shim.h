#ifndef CMPV_SHIM_H
#define CMPV_SHIM_H

// libmpv's C API, reached through Homebrew's include directory.
//
// SwiftPM compiles a system-library target with the plain clang include paths, so mpv's headers have to be
// named explicitly. Both prefixes are tried; whichever exists wins.
#if __has_include(<mpv/client.h>)
#include <mpv/client.h>
#include <mpv/render.h>
#include <mpv/render_gl.h>
#elif __has_include("/opt/homebrew/include/mpv/client.h")
#include "/opt/homebrew/include/mpv/client.h"
#include "/opt/homebrew/include/mpv/render.h"
#include "/opt/homebrew/include/mpv/render_gl.h"
#elif __has_include("/usr/local/include/mpv/client.h")
#include "/usr/local/include/mpv/client.h"
#include "/usr/local/include/mpv/render.h"
#include "/usr/local/include/mpv/render_gl.h"
#else
#error "mpv/client.h not found. Install it with: brew install mpv"
#endif

#endif /* CMPV_SHIM_H */