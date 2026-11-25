#include "r3c.h"
#include <ctype.h>
#include <math.h>

static int compare_function(const void *a, const void *b) {
	ut64 x = ((const Function *)a)->addr, y = ((const Function *)b)->addr;
	return (x > y) - (x < y);
}

static int compare_interval(const void *a, const void *b) {
	ut64 x = ((const Interval *)a)->start, y = ((const Interval *)b)->start;
	return (x > y) - (x < y);
}

static int compare_call(const void *a, const void *b) {
	const Call *x = a, *y = b;
	if (x->site != y->site) {
		return (x->site > y->site) - (x->site < y->site);
	}
	if (x->from != y->from) {
		return (x->from > y->from) - (x->from < y->from);
	}
	return (x->to > y->to) - (x->to < y->to);
}

static void *array_grow(void *array, size_t count, size_t size) {
	if (count > SIZE_MAX / size) {
		return NULL;
	}
	return realloc (array, count * size);
}

int model_entry(const Model *m, ut64 addr) {
	size_t low = 0, high = m->count;
	while (low < high) {
		size_t mid = low + (high - low) / 2;
		if (m->functions[mid].addr < addr) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}
	return low < m->count && m->functions[low].addr == addr? (int)low: -1;
}

int model_owner(const Model *m, ut64 addr) {
	int entry = model_entry (m, addr);
	if (entry >= 0) {
		return entry;
	}
	size_t low = 0, high = m->block_count;
	while (low < high) {
		size_t mid = low + (high - low) / 2;
		if (m->blocks[mid].start <= addr) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}
	while (low) {
		const Interval *block = &m->blocks[--low];
		if (block->prefix_end <= addr) {
			break;
		}
		if (block->start <= addr && addr < block->end) {
			return block->function;
		}
	}
	int result = -1;
	ut64 span = UT64_MAX;
	for (size_t i = 0; i < m->count; i++) {
		const Function *f = &m->functions[i];
		if (!f->has_blocks && f->min <= addr && addr < f->max && f->max - f->min < span) {
			span = f->max - f->min;
			result = (int)i;
		}
	}
	return result;
}

int model_find(const Model *m, const char *query) {
	if (!query || !*query) {
		return -1;
	}
	if (r_str_startswith (query, "0x")) {
		char *end;
		ut64 addr = strtoull (query, &end, 16);
		if (!*end) {
			return model_owner (m, addr);
		}
	}
	int best = -1;
	for (size_t i = 0; i < m->count; i++) {
		const char *name = m->functions[i].name;
		if (!strcmp (name, query)) {
			return (int)i;
		}
		if (r_str_casestr (name, query) && (best < 0 || strlen (name) < strlen (m->functions[best].name))) {
			best = (int)i;
		}
	}
	return best;
}

static bool load_blocks(Model *m, Backend *b) {
	if (b->core) {
		for (size_t i = 0; i < m->count; i++) {
			RAnalFunction *f = r_anal_get_function_at (b->core->anal, m->functions[i].addr);
			if (!f) {
				continue;
			}
			size_t count = RVecAnalBlockPtr_length (&f->bbs);
			Interval *blocks = array_grow (m->blocks, m->block_count + count, sizeof (Interval));
			if (count && !blocks) {
				return false;
			}
			m->blocks = blocks;
			RAnalBlock **bb;
			R_VEC_FOREACH (&f->bbs, bb) {
				ut64 start = (*bb)->addr, size = R_MAX (1, (*bb)->size);
				m->blocks[m->block_count++] = (Interval){ start, size > UT64_MAX - start? UT64_MAX: start + size, 0, (int)i };
				m->functions[i].has_blocks = true;
			}
		}
	} else {
		char *text = backend_command (b, "afbj @@F");
		if (!text) {
			return false;
		}
		char *line = text;
		while (line && *line) {
			char *next = strchr (line, '\n');
			if (next) {
				*next++ = 0;
			}
			RJson *array = r_json_parsedup (line);
			if (array && array->type == R_JSON_ARRAY && array->children.count) {
				int owner = -1, candidate = -1, candidates = 0;
				ut64 min = UT64_MAX, max = 0;
				for (const RJson *bb = array->children.first; bb; bb = bb->next) {
					ut64 at = json_number (bb, "addr", UT64_MAX), size = json_number (bb, "size", 1);
					min = R_MIN (min, at);
					max = R_MAX (max, at + R_MIN (size, UT64_MAX - at));
				}
				for (const RJson *bb = array->children.first; bb; bb = bb->next) {
					int fi = model_entry (m, json_number (bb, "addr", UT64_MAX));
					if (fi >= 0 && !m->functions[fi].has_blocks) {
						candidate = fi;
						candidates++;
						if (m->functions[fi].min <= min && m->functions[fi].max >= max - (max > 0)) {
							owner = fi;
							break;
						}
					}
				}
				if (owner < 0 && candidates == 1) {
					owner = candidate;
				}
				if (owner >= 0) {
					Interval *blocks = array_grow (m->blocks, m->block_count + array->children.count, sizeof (Interval));
					if (!blocks) {
						r_json_free (array);
						free (text);
						return false;
					}
					m->blocks = blocks;
					for (const RJson *bb = array->children.first; bb; bb = bb->next) {
						ut64 at = json_number (bb, "addr", UT64_MAX), size = json_number (bb, "size", 1);
						m->blocks[m->block_count++] = (Interval){ at, at + R_MIN (R_MAX (1, size), UT64_MAX - at), 0, owner };
					}
					m->functions[owner].has_blocks = true;
				}
			}
			r_json_free (array);
			line = next;
		}
		free (text);
	}
	if (m->block_count > 1) { qsort (m->blocks, m->block_count, sizeof (Interval), compare_interval); }
	ut64 end = 0;
	for (size_t i = 0; i < m->block_count; i++) {
		end = R_MAX (end, m->blocks[i].end);
		m->blocks[i].prefix_end = end;
	}
	return true;
}

static int string_index(const Model *m, ut64 addr) {
	for (size_t i = 0; i < m->string_count; i++) {
		if (m->strings[i].addr == addr) {
			return (int)i;
		}
	}
	return -1;
}

static bool load_calls(Model *m, Backend *b) {
	RJson *array = backend_json (b, "axlj");
	if (!array || array->type != R_JSON_ARRAY) {
		r_json_free (array);
		return false;
	}
	m->calls = calloc (R_MAX (1, array->children.count), sizeof (Call));
	m->string_refs = calloc (R_MAX (1, array->children.count), sizeof (StringRef));
	if (!m->calls || !m->string_refs) {
		r_json_free (array);
		return false;
	}
	for (const RJson *x = array->children.first; x; x = x->next) {
		const char *type = json_string (x, "type");
		ut64 site = json_number (x, "from", UT64_MAX), addr = json_number (x, "addr", UT64_MAX);
		if (!type) {
			continue;
		}
		int from = model_owner (m, site), to = model_entry (m, addr);
		if (from < 0) {
			continue;
		}
		if (to >= 0 && (!strcmp (type, "CALL") || (!strcmp (type, "CODE") && from != to) || (!strcmp (type, "DATA") && from != to))) {
			m->calls[m->call_count++] = (Call){ from, to, site, !strcmp (type, "CODE"), !strcmp (type, "DATA") };
		} else if (!strcmp (type, "STRN") || !strcmp (type, "DATA")) {
			int si = string_index (m, addr);
			if (si >= 0) {
				m->string_refs[m->string_ref_count++] = (StringRef){ from, si, site };
			}
		}
	}
	r_json_free (array);
	qsort (m->calls, m->call_count, sizeof (Call), compare_call);
	size_t count = 0;
	for (size_t i = 0; i < m->call_count; i++) {
		Call c = m->calls[i];
		if (count && !compare_call (&c, &m->calls[count - 1])) {
			continue;
		}
		m->calls[count++] = c;
		m->functions[c.from].outdegree++;
		m->functions[c.to].indegree++;
	}
	m->call_count = count;
	return true;
}

void model_layout(Model *m) {
	size_t count = 0;
	float max_complexity = 1, max_size = 1;
	for (size_t i = 0; i < m->count; i++) {
		count += !m->functions[i].imported;
		if (!m->functions[i].imported) {
			max_complexity = fmaxf (max_complexity, log2f (fmaxf (1, m->functions[i].cc)));
			max_size = fmaxf (max_size, log2f (1.f + m->functions[i].size));
		}
	}
	unsigned side = 1;
	while ((size_t)side * side < count) {
		side *= 2;
	}
	R3Vec center = {0};
	size_t index = 0, imports = m->count - count;
	m->radius = 30;
	for (size_t i = 0; i < m->count; i++) {
		Function *f = &m->functions[i];
		if (f->imported) {
			continue;
		}
		unsigned x = 0, y = 0, t = (unsigned)index++;
		for (unsigned s = 1; s < side; s *= 2) {
			unsigned rx = 1 & (t / 2), ry = 1 & (t ^ rx);
			if (!ry) {
				if (rx) { x = s - 1 - x; y = s - 1 - y; }
				unsigned swap = x; x = y; y = swap;
			}
			x += s * rx; y += s * ry; t /= 4;
		}
		f->city = r3_vec (x * 7.f, 0, y * 7.f);
		center = r3_add (center, f->city);
	}
	center = r3_scale (center, 1.f / R_MAX (1, count));
	index = 0;
	for (size_t i = 0; i < m->count; i++) {
		Function *f = &m->functions[i];
		if (!f->imported) {
			f->city = r3_sub (f->city, center);
			m->radius = fmaxf (m->radius, r3_length (f->city) + 8);
		}
		f->height = fminf (150, 2 + sqrtf (fmaxf (4, f->size)) * .42f);
		f->width = fminf (5.6f, 1.6f + log2f (1 + f->nbbs) * .5f);
		f->tint = .75f * log2f (fmaxf (1, f->cc)) / max_complexity + .25f * log2f (1.f + f->size) / max_size;
		m->max_height = fmaxf (m->max_height, f->height);
	}
	for (size_t i = 0; i < m->count; i++) {
		Function *f = &m->functions[i];
		if (f->imported) {
			float angle = index++ * 2 * R3_PI / R_MAX (1, imports);
			f->city = r3_vec (cosf (angle) * (m->radius + 28), 14 + 5 * sinf (angle * 3), sinf (angle) * (m->radius + 28));
			f->width = 2;
			f->height = 3;
		}
		f->position = f->city;
	}
	model_palette (m, NULL);
}

bool model_load(Model *m, Backend *b) {
	memset (m, 0, sizeof (*m));
	RJson *info = backend_json (b, "ij");
	if (!info) {
		return false;
	}
	const RJson *bin = json_field (info, "bin"), *core = json_field (info, "core");
	m->title = ascii_copy (json_string (core, "file"));
	m->arch = ascii_copy (json_string (bin, "arch"));
	m->bits = (int)json_number (bin, "bits", 0);
	r_json_free (info);
	RJson *array = backend_json (b, "aflj");
	if (!array || array->type != R_JSON_ARRAY || array->children.count > INT_MAX) {
		r_json_free (array);
		return false;
	}
	m->count = array->children.count;
	m->functions = calloc (R_MAX (1, m->count), sizeof (Function));
	if (!m->functions) {
		r_json_free (array);
		return false;
	}
	size_t i = 0;
	for (const RJson *fn = array->children.first; fn; fn = fn->next, i++) {
		Function *f = &m->functions[i];
		f->addr = json_number (fn, "addr", 0);
		f->size = json_number (fn, "realsz", json_number (fn, "size", 1));
		f->min = json_number (fn, "minaddr", f->addr);
		f->max = json_number (fn, "maxaddr", f->addr + R_MIN (f->size, UT64_MAX - f->addr));
		f->name = ascii_copy (json_string (fn, "name"));
		f->nbbs = (int)json_number (fn, "nbbs", 1);
		f->cc = (int)json_number (fn, "cc", 1);
		f->imported = f->name && (r_str_startswith (f->name, "sym.imp.") || r_str_startswith (f->name, "imp."));
	}
	r_json_free (array);
	qsort (m->functions, m->count, sizeof (Function), compare_function);
	array = backend_json (b, "izj");
	if (array && array->type == R_JSON_ARRAY) {
		m->string_count = R_MIN (20000, array->children.count);
		m->strings = calloc (R_MAX (1, m->string_count), sizeof (String));
		if (!m->strings) { r_json_free (array); return false; }
		i = 0;
		for (const RJson *s = array->children.first; s && i < m->string_count; s = s->next, i++) {
			m->strings[i] = (String){ json_number (s, "vaddr", 0), ascii_copy (json_string (s, "string")) };
		}
	}
	r_json_free (array);
	array = backend_json (b, "iSj");
	if (array && array->type == R_JSON_ARRAY) {
		m->section_count = array->children.count;
		m->sections = calloc (R_MAX (1, m->section_count), sizeof (Section));
		if (!m->sections) { r_json_free (array); return false; }
		i = 0;
		for (const RJson *s = array->children.first; s; s = s->next, i++) {
			m->sections[i].name = ascii_copy (json_string (s, "name"));
			m->sections[i].addr = json_number (s, "vaddr", 0);
			m->sections[i].size = json_number (s, "vsize", json_number (s, "size", 0));
			const char *perm = json_string (s, "perm");
			snprintf (m->sections[i].perm, sizeof (m->sections[i].perm), "%s", perm? perm: "");
		}
	}
	r_json_free (array);
	array = backend_json (b, "iej");
	m->entry = array && array->type == R_JSON_ARRAY? json_number (array->children.first, "vaddr", 0): 0;
	r_json_free (array);
	array = backend_json (b, "p=ej 128 @ 0 @e:zoom.in=raw,io.va=false");
	const RJson *values = json_field (array, "entropy");
	if (values && values->type == R_JSON_ARRAY) {
		m->entropy_count = values->children.count;
		m->entropy = calloc (R_MAX (1, m->entropy_count), sizeof (Entropy));
		if (!m->entropy) { r_json_free (array); return false; }
		i = 0;
		for (const RJson *v = values->children.first; v; v = v->next, i++) {
			m->entropy[i] = (Entropy){ json_number (v, "addr", 0), json_number (v, "value", 0) / 255.f };
		}
	}
	r_json_free (array);
	if (!load_blocks (m, b) || !load_calls (m, b)) {
		return false;
	}
	model_layout (m);
	return true;
}

bool model_demo(Model *m) {
	memset (m, 0, sizeof (*m));
	m->count = 192;
	m->functions = calloc (m->count, sizeof (Function));
	m->calls = calloc (m->count * 3, sizeof (Call));
	m->entropy_count = 128;
	m->entropy = calloc (m->entropy_count, sizeof (Entropy));
	m->title = strdup ("NEON ARCHIVE / native renderer demo");
	m->arch = strdup ("demo");
	m->bits = 64;
	if (!m->functions || !m->calls || !m->entropy || !m->title || !m->arch) { return false; }
	for (size_t i = 0; i < m->count; i++) {
		Function *f = &m->functions[i];
		f->addr = 0x1000 + i * 0x100;
		f->min = f->addr;
		f->max = f->addr + 0xff;
		f->size = 40 + (ut64)(r3_hash ((uint32_t)i * 17) * 7000);
		f->cc = 1 + (int)(r3_hash ((uint32_t)i * 3) * 60);
		f->nbbs = f->cc + 1;
		f->imported = i >= m->count - 12;
		f->name = i == 0? strdup ("main"): r_str_newf ("%s.%s_%03zu", f->imported? "sym.imp": "sym", i % 3? "decode": "dispatch", i);
		for (int j = 0; j < 2; j++) {
			int to = (int)(r3_hash ((uint32_t)(i * 13 + j * 83 + 5)) * (m->count - 1));
			m->calls[m->call_count++] = (Call){ (int)i, to, f->addr + 16 + j * 24, false, false };
		}
	}
	for (size_t i = 0; i < m->entropy_count; i++) {
		m->entropy[i] = (Entropy){ 0x1000 + i * 384, .2f + .8f * r3_hash ((uint32_t)i * 7) };
	}
	m->entry = m->functions[0].addr;
	model_layout (m);
	return true;
}

void model_free(Model *m) {
	for (size_t i = 0; m->functions && i < m->count; i++) { free (m->functions[i].name); }
	for (size_t i = 0; m->strings && i < m->string_count; i++) { free (m->strings[i].text); }
	for (size_t i = 0; m->sections && i < m->section_count; i++) { free (m->sections[i].name); }
	free (m->functions); free (m->blocks); free (m->calls); free (m->strings);
	free (m->string_refs); free (m->sections); free (m->entropy); free (m->title); free (m->arch);
	memset (m, 0, sizeof (*m));
}

void graph_free(Graph *g) {
	for (size_t i = 0; g->blocks && i < g->count; i++) {
		for (size_t j = 0; g->blocks[i].ops && j < g->blocks[i].op_count; j++) { free (g->blocks[i].ops[j].text); }
		free (g->blocks[i].ops);
		free (g->blocks[i].cases);
	}
	free (g->blocks);
	for (size_t i = 0; i < g->route_count; i++) { free (g->routes[i].points); }
	free (g->routes);
	memset (g, 0, sizeof (*g));
}

int graph_block(const Graph *g, ut64 addr) {
	for (size_t i = 0; i < g->count; i++) {
		if (g->blocks[i].addr == addr) { return (int)i; }
	}
	return -1;
}

bool graph_load(Graph *g, Backend *backend, const Model *m, int function) {
	graph_free (g);
	g->function = function;
	char *cmd = r_str_newf ("agfj @ 0x%" PFMT64x, m->functions[function].addr);
	RJson *json = backend_json (backend, cmd);
	free (cmd);
	const RJson *root = json && json->type == R_JSON_ARRAY? r_json_item (json, 0): NULL;
	const RJson *blocks = json_field (root, "blocks");
	if (!blocks || blocks->type != R_JSON_ARRAY || blocks->children.count > 10000) {
		r_json_free (json);
		return false;
	}
	g->count = blocks->children.count;
	g->blocks = calloc (R_MAX (1, g->count), sizeof (Block));
	if (!g->blocks) { r_json_free (json); g->count = 0; return false; }
	size_t i = 0;
	for (const RJson *bb = blocks->children.first; bb; bb = bb->next, i++) {
		Block *b = &g->blocks[i];
		b->addr = json_number (bb, "addr", 0);
		b->jump = json_number (bb, "jump", UT64_MAX);
		b->fail = json_number (bb, "fail", UT64_MAX);
		const RJson *cases = json_field (json_field (bb, "switchop"), "cases");
		if (cases && cases->type == R_JSON_ARRAY) {
			b->cases = calloc (R_MAX (1, cases->children.count), sizeof (ut64));
			if (!b->cases) { r_json_free (json); return false; }
			for (const RJson *c = cases->children.first; c; c = c->next) { b->cases[b->case_count++] = json_number (c, "jump", UT64_MAX); }
		}
		const RJson *ops = json_field (bb, "ops");
		b->op_count = ops && ops->type == R_JSON_ARRAY? ops->children.count: 0;
		b->ops = calloc (R_MAX (1, b->op_count), sizeof (Instruction));
		if (!b->ops) { r_json_free (json); return false; }
		size_t j = 0;
		for (const RJson *op = b->op_count? ops->children.first: NULL; op; op = op->next, j++) {
			const char *text = json_string (op, "disasm"), *type = json_string (op, "type");
			if (!text) { text = json_string (op, "opcode"); }
			b->ops[j] = (Instruction){ json_number (op, "addr", b->addr), json_number (op, "jump", UT64_MAX), json_number (op, "fail", UT64_MAX), ascii_copy (text), type && strstr (type, "call") };
		}
	}
	r_json_free (json);
	return graph_layout (g);
}
