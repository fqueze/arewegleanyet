const fs = require('fs').promises;
const { exec } = require("node:child_process");
const YAML = require('yaml');

const pathPrefix = "./mozilla-central/";
const eventsPath = pathPrefix + "toolkit/components/telemetry/Events.yaml";
const histogramPath = pathPrefix + "toolkit/components/telemetry/Histograms.json";
const scalarsPath = pathPrefix + "toolkit/components/telemetry/Scalars.yaml";

const dataFile = "./data.json";

const telemetryFiles = [
  "toolkit/components/telemetry/Events.yaml",
  "toolkit/components/telemetry/Histograms.json",
  "toolkit/components/telemetry/Scalars.yaml",
];

const firstGleanNightly = "20201005215809";

function execCmd(cmd, silent = false) {
  if (!silent) {
    console.log(cmd);
  }
  let options = {maxBuffer: 1024 * 1024 * 50,
                 cwd: pathPrefix};
  return new Promise((resolve, reject) => {
    exec(cmd, options,
         (error, stdout, stderr) => {
           if (stderr) {
             console.log(`stderr: ${stderr}`);
             if (!stdout) {
               reject(stderr);
               return;
             }
           }
           if (error) {
             reject(error);
             return;
           }
           resolve(stdout);
         })
  });
}

function git(cmd) {
  cmd = "git " + cmd;
  console.log(cmd);
  let options = {maxBuffer: 1024 * 1024 * 50};
  return new Promise((resolve, reject) => {
    exec(cmd, options,
         (error, stdout, stderr) => {
           if (stderr) {
             console.log(`stderr: ${stderr}`);
             if (!stdout) {
               reject(stderr);
               return;
             }
           }
           if (error) {
             reject(error);
             return;
           }
           resolve(stdout);
         })
  });
}

async function parseMetricsYaml(path) {
  const yamlText = await fs.readFile(pathPrefix + path, {
    encoding: "utf-8",
  });
  let result;
  try {
    result = YAML.parse(yamlText, null, {uniqueKeys: false});
  } catch(e) { console.log(path, e); }
  return result;
}

async function listMetricsYaml() {
  let metricsYaml = await new Promise((resolve, reject) => {
    exec(`python3 -c 'exec(open("metrics_index.py").read());print("\\n".join(metrics_yamls))'`, {
      cwd: pathPrefix + "toolkit/components/glean",
      maxBuffer: 1024 * 1024 * 50
    },
         (error, stdout, stderr) => {
           if (stderr) {
             console.log(`stderr: ${stderr}`);
             reject(stderr);
             return;
           }
           if (error) {
             // Assume rg returning an error means 'no match'.
             resolve([]);
             return;
           }
           resolve(stdout.split("\n").filter(l => l));
         })
  });

  cache.metricsFiles = metricsYaml;
  cache.metricsYaml = await Promise.all(metricsYaml.map(parseMetricsYaml));
}

async function listMirrors() {
  let mirrors = await new Promise((resolve, reject) => {
    exec(`rg telemetry_mirror: -g '!obj-*' -g '!*~' -g 'metrics.yaml' -g '!.hg*' --json ${pathPrefix}`, {maxBuffer: 1024 * 1024 * 50},
         (error, stdout, stderr) => {
           if (stderr) {
             console.log(`stderr: ${stderr}`);
             reject(stderr);
             return;
           }
           if (error) {
             // Assume rg returning an error means 'no match'.
             resolve([]);
             return;
           }
           let lines = stdout.split("\n").filter(l => l).map(JSON.parse);
           let matches = lines.filter(l => l.type == "match").map(l => l.data).map(m => {
             return { path: m.path.text.replace(pathPrefix, ""),
                      line: m.line_number,
                      text: m.lines.text.slice(0,250).replace("\n", "") };
           });
           resolve(matches);
         })
  });

  cache.mirrors = new Map();
  mirrors.forEach(m => {
    let {path, line, text} = m;
    let name = text.replace(/^.*telemetry_mirror: /, "");
    cache.mirrors.set(name, m);
  });
}

async function readEvents() {
  const eventsText = await fs.readFile(eventsPath, {
    encoding: "utf-8",
  });
  cache.events = YAML.parse(eventsText, null, {uniqueKeys: false});
}

async function readHistograms() {
  const histograms = await fs.readFile(histogramPath, {
    encoding: "utf-8",
  });
  cache.histograms = JSON.parse(histograms);
}

async function readScalars() {
  const scalarsText = await fs.readFile(scalarsPath, {
    encoding: "utf-8",
  });
  cache.scalars = YAML.parse(scalarsText, null, {uniqueKeys: false});
}

function eventHasMirror(key, name) {
  let ucfirst = s => s[0].toUpperCase() + s.slice(1).toLowerCase();
  let hasMirror = false;
  let probe = cache.events[key][name];
  for (let obj of probe.objects) {
    for (let method of (probe.methods || [name])) {
      let CppName = [key.split(".").map(ucfirst).join(""),
                     method.split("_").map(ucfirst).join(""),
                     obj.split("_").map(ucfirst).join("")].join("_");
      let m = cache.mirrors.get(CppName);
      if (m) {
        return true;
      }
    }
  }
  return false;
}

let cache;
async function processRelease() {
  cache = {};

  return Promise.all([listMirrors(), readEvents(), readHistograms(), readScalars(), listMetricsYaml()]).then(() => {
    let eventCount = 0;
    let eventsWithoutMirror = 0;
    for (let key in cache.events) {
      if (key.startsWith("telemetry.test")) {
        continue;
      }

      let group = cache.events[key];
      for (let name in group) {
        ++eventCount;
        if (!eventHasMirror(key, name)) {
          ++eventsWithoutMirror;
        }
      }
    }

    let histograms = Object.keys(cache.histograms).filter(h => !h.startsWith("TELEMETRY_TEST_"));
    let histogramsWithoutMirrors = histograms.filter(h => !cache.mirrors.get(h)).length;
    let scalarCount = 0;
    let scalarsWithoutMirror = 0;
    for (let key in cache.scalars) {
      if (key == "telemetry.test") {
        continue;
      }
      for (let name in cache.scalars[key]) {
        ++scalarCount;
        let mirrorName = `${key}_${name}`.toUpperCase();
        if (!cache.mirrors.get(mirrorName)) {
          ++scalarsWithoutMirror;
        }
      }
    }

    let metrics = 0;
    let metricsWithTelemetryMirror = 0;
    let metricsWithoutUseCounters = 0;
    for (let metricsYaml of cache.metricsYaml) {
      for (let key in metricsYaml) {
        if (key.startsWith('$')) {
          continue;
        }
        let names = Object.keys(metricsYaml[key]);
        metrics += names.length;
        if (!key.startsWith("use.counter")) {
          metricsWithoutUseCounters += names.length;
        }
        metricsWithTelemetryMirror +=
          names.filter(name => metricsYaml[key][name].telemetry_mirror).length;
      }
    }

    let data = {
      events: eventCount,
      legacyOnlyEvents: eventsWithoutMirror,
      histograms: histograms.length,
      legacyOnlyHistograms: histogramsWithoutMirrors,
      scalars: scalarCount,
      legacyOnlyScalars: scalarsWithoutMirror,
      metrics,
      metricsWithoutUseCounters,
      metricsWithTelemetryMirror
    };
    return data;
  });
}

async function checkForUpdates() {
  let cacheJson = "";
  try {
    cacheJson = await fs.readFile(dataFile, { encoding: "utf-8" });
  } catch(e) {
    console.log(e);
  }
  let knownReleases = new Set(
    cacheJson.split("\n")
      .filter(line => !!line)
      .map(line => JSON.parse(line).buildid)
  );

  let allReleases = [];
  let response = await fetch("https://hg.mozilla.org/mozilla-central/firefoxreleases");
  let body = await response.text();
  let releases = body.split("\n").filter(l => l.includes('<tr id="') && l.includes("win64") && l.includes("nightlywin64202"));
  for (let release of releases) {
    let match = release.match(/"([a-z0-9]+)nightlywin64(202[0-9]+)"/);
    if (!match) {
      console.log("unexpected line:", release);
      continue;
    }
    let [, hash, buildid] = match;
    if (buildid < firstGleanNightly) {
      continue;
    }
    allReleases.push({hash, buildid});
  }
  allReleases.reverse();

  let newReleases = [];
  let prevHash;
  for (let {hash, buildid} of allReleases) {
    if (!knownReleases.has(buildid)) {
      newReleases.push({hash, buildid, prevHash});
    }
    prevHash = hash;
  }

  if (newReleases.length) {
    await execCmd(`hg pull`);

    for (let {hash, buildid, prevHash} of newReleases) {
      await execCmd(`hg update -r ${hash}`);

      let data = await processRelease();

      let log = "";
      if (prevHash) {
        log = await execCmd(`hg log -r ${prevHash}:${hash} --template '{author|user}: {desc|strip|firstline}\n' ${telemetryFiles.join(" ")} toolkit/components/glean/metrics_index.py ${cache.metricsFiles.join(" ")}`, true);
        log = log.trim();
      }

      let newLine = JSON.stringify({buildid, data, log});
      console.log(newLine);
      cacheJson += newLine + "\n";
    }

    await fs.writeFile(dataFile, cacheJson);

    let buildids = newReleases.map(({buildid}) => buildid)
    let string = buildids.join(", ").replace(/, ([^,]*)$/, " and $1");
    await git(`commit -m 'Automated update for build id${buildids.length > 1 ? "s" : ""} ${string}.' ${dataFile}`);
    await git("push");
  }
}

// Update once now, and then every 6 hours
checkForUpdates();
setInterval(checkForUpdates, 6 * 3600 * 1000);
