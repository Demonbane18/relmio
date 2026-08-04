#include <windows.h>
#include <shellapi.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

static bool append_text(wchar_t **cursor, const wchar_t *value) {
  const size_t length = wcslen(value);
  memcpy(*cursor, value, length * sizeof(wchar_t));
  *cursor += length;
  return true;
}

static bool append_quoted_argument(wchar_t **cursor, const wchar_t *argument) {
  size_t backslashes = 0;
  append_text(cursor, L"\"");

  for (const wchar_t *character = argument; *character != L'\0'; character += 1) {
    if (*character == L'\\') {
      backslashes += 1;
      continue;
    }

    if (*character == L'\"') {
      for (size_t index = 0; index < backslashes * 2 + 1; index += 1) {
        append_text(cursor, L"\\");
      }
    } else {
      for (size_t index = 0; index < backslashes; index += 1) {
        append_text(cursor, L"\\");
      }
    }
    backslashes = 0;
    **cursor = *character;
    *cursor += 1;
  }

  for (size_t index = 0; index < backslashes * 2; index += 1) {
    append_text(cursor, L"\\");
  }
  append_text(cursor, L"\"");
  return true;
}

int wmain(void) {
  wchar_t launcher_path[MAX_PATH];
  wchar_t runtime_path[MAX_PATH];
  wchar_t script_path[MAX_PATH];
  DWORD launcher_length;
  int argument_count = 0;
  wchar_t **arguments;
  wchar_t *command_line;
  wchar_t *cursor;
  size_t command_capacity = 0;
  STARTUPINFOW startup_info = { .cb = sizeof(STARTUPINFOW) };
  PROCESS_INFORMATION process_info = { 0 };
  DWORD exit_code = 1;

  launcher_length = GetModuleFileNameW(NULL, launcher_path, MAX_PATH);
  if (launcher_length == 0 || launcher_length >= MAX_PATH) {
    fputws(L"Relmio could not resolve its installation folder.\n", stderr);
    return 1;
  }

  wchar_t *directory_separator = wcsrchr(launcher_path, L'\\');
  if (directory_separator == NULL) {
    fputws(L"Relmio could not resolve its installation folder.\n", stderr);
    return 1;
  }
  *directory_separator = L'\0';

  if (swprintf_s(runtime_path, MAX_PATH, L"%s\\runtime\\node.exe", launcher_path) < 0 ||
      swprintf_s(script_path, MAX_PATH, L"%s\\app\\node_modules\\relmio\\src\\cli.js", launcher_path) < 0) {
    fputws(L"Relmio installation paths are too long.\n", stderr);
    return 1;
  }

  arguments = CommandLineToArgvW(GetCommandLineW(), &argument_count);
  if (arguments == NULL) {
    fputws(L"Relmio could not read its command line.\n", stderr);
    return 1;
  }

  command_capacity = (wcslen(runtime_path) + wcslen(script_path) + 8) * sizeof(wchar_t);
  for (int index = 1; index < argument_count; index += 1) {
    command_capacity += (wcslen(arguments[index]) * 2 + 4) * sizeof(wchar_t);
  }
  command_line = calloc(1, command_capacity);
  if (command_line == NULL) {
    LocalFree(arguments);
    fputws(L"Relmio could not allocate a command line.\n", stderr);
    return 1;
  }

  cursor = command_line;
  append_quoted_argument(&cursor, runtime_path);
  append_text(&cursor, L" ");
  append_quoted_argument(&cursor, script_path);
  for (int index = 1; index < argument_count; index += 1) {
    append_text(&cursor, L" ");
    append_quoted_argument(&cursor, arguments[index]);
  }

  if (!CreateProcessW(runtime_path, command_line, NULL, NULL, TRUE, 0, NULL,
                      launcher_path, &startup_info, &process_info)) {
    free(command_line);
    LocalFree(arguments);
    fputws(L"Relmio could not start its bundled Node.js runtime. Reinstall the package.\n", stderr);
    return 1;
  }

  WaitForSingleObject(process_info.hProcess, INFINITE);
  if (!GetExitCodeProcess(process_info.hProcess, &exit_code)) {
    exit_code = 1;
  }
  CloseHandle(process_info.hThread);
  CloseHandle(process_info.hProcess);
  free(command_line);
  LocalFree(arguments);
  return (int)exit_code;
}
