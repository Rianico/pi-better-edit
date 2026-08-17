import { encode } from "gpt-tokenizer/encoding/cl100k_base";

const path = "src/service.ts";
const edits = [
	["a01", "const timeoutMs = 1000;", "const timeoutMs = 1500;"],
	["b02", "const retries = 2;", "const retries = 3;"],
	["c03", "const cacheTtl = 60;", "const cacheTtl = 120;"],
	["d04", "const batchSize = 16;", "const batchSize = 32;"],
	["e05", "const maxItems = 100;", "const maxItems = 250;"],
	["f06", "const logLevel = \"info\";", "const logLevel = \"debug\";"],
	["g07", "const useCache = false;", "const useCache = true;"],
	["h08", "const keepAlive = false;", "const keepAlive = true;"],
	["i09", "const port = 3000;", "const port = 3001;"],
	["j10", "const host = \"localhost\";", "const host = \"127.0.0.1\";"],
	["k11", "const region = \"us-east-1\";", "const region = \"us-west-2\";"],
	["l12", "const mode = \"safe\";", "const mode = \"strict\";"],
];

const tokenCount = (value) => encode(value).length;
const strReplaceCalls = edits.map(([, oldText, newText]) =>
	JSON.stringify({ path, old_string: oldText, new_string: newText }),
);
const editCalls = edits.map(([anchor, , newText]) =>
	JSON.stringify([path, [anchor, anchor], newText]),
);
const batchCall = JSON.stringify(
	edits.map(([anchor, , newText]) => [path, [anchor, anchor], newText]),
);
const strReplaceTokens = strReplaceCalls.reduce(
	(total, call) => total + tokenCount(call),
	0,
);
const editTokens = editCalls.reduce((total, call) => total + tokenCount(call), 0);
const batchTokens = tokenCount(batchCall);
const savedRate = (tokens) => ((1 - tokens / strReplaceTokens) * 100).toFixed(1);

const result = {
	benchmark: "token-economics",
	tokenizer: "cl100k_base",
	scenario: "12-edit configuration refactor",
	edits: edits.length,
	arms: [
		{
			name: "str_replace-style JSON",
			tokens: strReplaceTokens,
			savedPercent: "0.0",
			calls: strReplaceCalls.length,
		},
		{
			name: "this project: edit",
			tokens: editTokens,
			savedPercent: savedRate(editTokens),
			calls: editCalls.length,
		},
		{
			name: "this project: batch_edit",
			tokens: batchTokens,
			savedPercent: savedRate(batchTokens),
			calls: 1,
		},
	],
};

console.log(JSON.stringify(result, null, 2));
