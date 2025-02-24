const fs = require('fs').promises;
const { exec } = require("node:child_process");
const YAML = require('yaml');

const pathPrefix = "./mozilla-central/";
const eventsPath = pathPrefix + "toolkit/components/telemetry/Events.yaml";
const histogramPath = pathPrefix + "toolkit/components/telemetry/Histograms.json";
const scalarsPath = pathPrefix + "toolkit/components/telemetry/Scalars.yaml";
const environmentPath = pathPrefix + "toolkit/components/telemetry/app/TelemetryEnvironment.sys.mjs";
const oldEnvironmentPath = pathPrefix + "toolkit/components/telemetry/app/TelemetryEnvironment.jsm";

const dataFile = "./data.json";

const telemetryFiles = [
  "toolkit/components/telemetry/Events.yaml",
  "toolkit/components/telemetry/Histograms.json",
  "toolkit/components/telemetry/Scalars.yaml",
  "toolkit/components/telemetry/app/TelemetryEnvironment.sys.mjs",
];

const firstGleanNightly = "20201005215809";

let DEBUG = false;

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
  if (DEBUG) {
    return;
  }
  let options = {maxBuffer: 1024 * 1024 * 50};
  return new Promise((resolve, reject) => {
    exec(cmd, options,
         (error, stdout, stderr) => {
           if (stderr) {
             console.log(stderr);
           }
           if (error) {
             reject(error);
           } else {
             resolve(stdout);
           }
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

  cache.mirrors = new Set()
  for (let metricsYaml of cache.metricsYaml) {
    for (let key in metricsYaml) {
      if (key.startsWith('$')) {
        continue;
      }
      for (let name in metricsYaml[key]) {
        if (metricsYaml[key][name].telemetry_mirror) {
          let mirror = metricsYaml[key][name].telemetry_mirror;
          if (mirror.startsWith("h#")) {
            mirror = mirror.slice("h#".length);
          }
          cache.mirrors.add(mirror);
        }
      }
    }
  }
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

async function readEnvironment() {
  cache.environment = await fs.readFile(environmentPath, {
    encoding: "utf-8",
  }).catch(() => {
    return fs.readFile(oldEnvironmentPath, {
      encoding: "utf-8",
    });
  });
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
      if (cache.mirrors.has(CppName)) {
        return true;
      }
    }
  }
  return false;
}

let cache;
async function processRelease() {
  cache = {};

  return Promise.all([readEvents(), readHistograms(), readScalars(), listMetricsYaml(), readEnvironment()]).then(() => {
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
    let histogramsWithoutMirrors = histograms.filter(h => !cache.mirrors.has(h)).length;

    let scalarCount = 0;
    let scalarsWithoutMirror = 0;
    for (let key in cache.scalars) {
      if (key == "telemetry.test" || key == "telemetry.discarded") {
        continue;
      }
      for (let name in cache.scalars[key]) {
        if (key == "telemetry" && [
          "accumulate_unknown_histogram_keys",
          "accumulate_clamped_values",
          "event_counts",
          "keyed_scalars_exceed_limit",
          "keyed_scalars_unknown_keys",
        ].includes(name)) {
          continue;
        }

        ++scalarCount;
        let mirrorName = `${key}_${name}`.toUpperCase().replace(/\./g, "_");
        if (!cache.mirrors.has(mirrorName)) {
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

    // The default amount of environment probes,
    // determined on 2025-01-28 to be 127.
    let environmentProbes = 127;
    // Default to assuming builds without annotation
    // are from before migration and had no Glean.
    let environmentMetrics = 0;
    // The Legacy Telemetry Environment is annoying,
    // so we list the counts in comments.
    let legacyCount = cache.environment.match(/Legacy Count: ([0-9]+)/);
    if (legacyCount) {
      [, environmentProbes] = legacyCount;
    }
    let gleanCount = cache.environment.match(/Glean Count: ([0-9]+)/);
    if (gleanCount) {
      [, environmentMetrics] = gleanCount;
    }
    let legacyOnlyEnvironmentProbes = environmentProbes - environmentMetrics;

    let data = {
      events: eventCount,
      legacyOnlyEvents: eventsWithoutMirror,
      histograms: histograms.length,
      legacyOnlyHistograms: histogramsWithoutMirrors,
      scalars: scalarCount,
      legacyOnlyScalars: scalarsWithoutMirror,
      metrics,
      metricsWithoutUseCounters,
      metricsWithTelemetryMirror,
      legacyOnlyEnvironmentProbes,
      environmentProbes,
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

  if (!newReleases.length) {
    console.log("No new Nightly release.");
    return;
  }

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

// Update once now, and then every 6 hours
checkForUpdates();
setInterval(checkForUpdates, 6 * 3600 * 1000);
