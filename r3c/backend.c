#include "r3c.h"

char *ascii_copy(const char *text) {
	char *copy = strdup (text? text: "");
	if (copy) {
		r_str_ansi_strip (copy);
		for (unsigned char *p = (unsigned char *)copy; *p; p++) {
			if (*p == 127 || (*p < 32 && *p != '\n' && *p != '\t')) {
				*p = '?';
			}
		}
	}
	return copy;
}

ut64 json_number(const RJson *json, const char *key, ut64 fallback) {
	const RJson *value = json_field (json, key);
	return value && value->type == R_JSON_INTEGER? value->num.u_value: fallback;
}

char *backend_command(Backend *b, const char *command) {
	b->error[0] = 0;
	if (b->core) {
		return r_core_cmd_str (b->core, command);
	}
	if (!b->endpoint) {
		return NULL;
	}
	const char *headers[] = { "Content-Type: text/plain; charset=utf-8", NULL };
	int code = 0, length = 0;
	char *result = r_socket_http_post (b->endpoint, headers, command, &code, &length);
	if (!result || code < 200 || code >= 300) {
		snprintf (b->error, sizeof (b->error), "HTTP command failed (status %d)", code);
		free (result);
		return NULL;
	}
	return result;
}

RJson *backend_json(Backend *b, const char *command) {
	char *text = backend_command (b, command);
	if (!text) {
		return NULL;
	}
	RJson *json = r_json_parsedup (text);
	if (!json) {
		snprintf (b->error, sizeof (b->error), "Invalid JSON response to %.100s", command);
	}
	free (text);
	return json;
}

bool backend_open(Backend *b, const char *path, const char *url, const char *analysis) {
	memset (b, 0, sizeof (*b));
	if (url) {
		if (!r_str_startswith (url, "http://") && !r_str_startswith (url, "https://")) {
			snprintf (b->error, sizeof (b->error), "Expected an http:// or https:// URL");
			return false;
		}
		b->endpoint = strdup (url);
		if (!b->endpoint) {
			return false;
		}
		size_t n = strlen (b->endpoint);
		while (n && b->endpoint[n - 1] == '/') {
			b->endpoint[--n] = 0;
		}
		if (n < 4 || strcmp (b->endpoint + n - 4, "/cmd")) {
			char *endpoint = r_str_newf ("%s/cmd", b->endpoint);
			free (b->endpoint);
			b->endpoint = endpoint;
		}
		b->name = strdup ("remote r2");
	} else {
		b->core = r_core_new ();
		if (!b->core) {
			return false;
		}
		b->owns_core = true;
		r_config_set_i (b->core->config, "scr.color", 3);
		r_config_set_b (b->core->config, "scr.interactive", false);
		r_config_set_i (b->core->config, "scr.maxpage", 0);
		r_config_set_b (b->core->config, "scr.utf8", false);
		r_config_set_b (b->core->config, "asm.bytes", false);
		r_config_set_b (b->core->config, "bin.cache", true);
		if (!r_core_file_open (b->core, path, R_PERM_R, UT64_MAX)) {
			snprintf (b->error, sizeof (b->error), "Cannot open binary: %.180s", path);
			return false;
		}
		if (!r_core_bin_load (b->core, path, UT64_MAX)) {
			snprintf (b->error, sizeof (b->error), "Cannot load binary: %.180s", path);
			return false;
		}
		b->name = ascii_copy (path);
	}
	return backend_analyze (b, analysis);
}

bool backend_analyze(Backend *b, const char *analysis) {
	if (analysis && strcmp (analysis, "none")) {
		char *result = backend_command (b, analysis);
		if (!result) {
			return false;
		}
		free (result);
	}
	return true;
}

void backend_close(Backend *b) {
	if (b->owns_core) {
		r_core_free (b->core);
	}
	free (b->endpoint);
	free (b->name);
	memset (b, 0, sizeof (*b));
}
