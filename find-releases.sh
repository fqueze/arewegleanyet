#!/bin/bash

curl https://hg.mozilla.org/mozilla-central/firefoxreleases| fgrep '<tr id="'|grep win64|sed 's/.*id="//;s/".*//;s/nightlywin64/ /'|grep ' 202'
