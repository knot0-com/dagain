function result(obj) {
  process.stdout.write(`<result>${JSON.stringify(obj)}</result>\n`);
}

result({
  status: "success",
  summary: "mock chat router",
  data: {
    reply: "",
    ops: [{ type: "control.pause" }],
  },
});

