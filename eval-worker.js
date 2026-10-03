self.onmessage = async event => {
  const { code, files, args } = event.data;
  const fs = Object.freeze({
    list: () => Object.keys(files),
    read: path => {
      if (!(path in files)) throw new Error('File not found: ' + path);
      return files[path];
    }
  });
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const result = await new AsyncFunction('fs', 'args', '"use strict";\n' + code)(fs, args);
    self.postMessage({ result: JSON.stringify(result) ?? 'undefined' });
  } catch (error) { self.postMessage({ error: error.message }); }
};