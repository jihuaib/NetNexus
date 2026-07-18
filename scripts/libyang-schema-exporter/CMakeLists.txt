cmake_minimum_required(VERSION 3.16)
project(netnexus_libyang_schema C)

if(NOT NETNEXUS_LIBYANG_SOURCE OR NOT NETNEXUS_LIBYANG_BUILD OR NOT NETNEXUS_PCRE2_ROOT)
    message(FATAL_ERROR
        "NETNEXUS_LIBYANG_SOURCE, NETNEXUS_LIBYANG_BUILD, and NETNEXUS_PCRE2_ROOT are required")
endif()

find_package(Threads REQUIRED)
find_library(NETNEXUS_LIBYANG_LIBRARY
    NAMES yang libyang
    PATHS "${NETNEXUS_LIBYANG_BUILD}" "${NETNEXUS_LIBYANG_BUILD}/Release"
    NO_DEFAULT_PATH
    REQUIRED)
find_library(NETNEXUS_PCRE2_LIBRARY
    NAMES pcre2-8
    PATHS
        "${NETNEXUS_PCRE2_ROOT}/lib"
        "${NETNEXUS_PCRE2_ROOT}/lib64"
        "${NETNEXUS_PCRE2_ROOT}/lib/Release"
    NO_DEFAULT_PATH
    REQUIRED)

add_executable(netnexus-libyang-schema ../netnexus-libyang-schema.c)
set_target_properties(netnexus-libyang-schema PROPERTIES
    C_STANDARD 11
    C_STANDARD_REQUIRED YES
    C_EXTENSIONS NO)
target_compile_definitions(netnexus-libyang-schema PRIVATE STATIC)
target_include_directories(netnexus-libyang-schema PRIVATE
    "${NETNEXUS_LIBYANG_BUILD}"
    "${NETNEXUS_LIBYANG_BUILD}/libyang"
    "${NETNEXUS_LIBYANG_SOURCE}/src"
    "${NETNEXUS_LIBYANG_SOURCE}/src/plugins_exts"
    "${NETNEXUS_PCRE2_ROOT}/include")
target_link_libraries(netnexus-libyang-schema PRIVATE
    "${NETNEXUS_LIBYANG_LIBRARY}"
    "${NETNEXUS_PCRE2_LIBRARY}"
    Threads::Threads
    ${CMAKE_DL_LIBS})
if(NOT WIN32)
    target_link_libraries(netnexus-libyang-schema PRIVATE m)
endif()

if(MSVC)
    target_compile_options(netnexus-libyang-schema PRIVATE /W4 /utf-8)
else()
    target_compile_options(netnexus-libyang-schema PRIVATE -Wall -Wextra -Wpedantic)
endif()
