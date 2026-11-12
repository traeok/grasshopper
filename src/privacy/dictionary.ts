import { loadConfig } from "../core/config.ts";

const words = (seed: string): Set<string> => new Set(seed.trim().split(/\s+/));

export const COMMANDS: Set<string> = words(`
alias unalias cd pushd popd dirs pwd ls ll la l dir echo printf cat tac nl less more head tail grep egrep fgrep zgrep find locate xargs sort uniq wc cut tr sed awk gawk tee touch mkdir rmdir rm cp mv ln chmod chown chgrp stat file basename dirname realpath readlink which whereis type command builtin hash history fc clear cls reset exit logout source . export unset set setopt unsetopt shopt bind bindkey env printenv true false test sleep wait jobs fg bg disown kill killall pkill pgrep ps top htop btop time date cal uptime whoami id groups hostname uname df du free mount umount lsblk tar gzip gunzip zip unzip 7z xz bzip2 zcat zstd diff cmp patch comm join paste split column od xxd hexdump strings base64 md5sum sha1sum sha256sum sha512sum shasum cksum seq yes watch nohup nice timeout exec eval trap ulimit umask man info help apropos open xdg-open start explorer notepad code code-insiders cursor subl vim vi nvim nano emacs micro hx tput stty lsof strace
curl wget ssh scp sftp rsync ping traceroute tracert nslookup dig host netstat ss ip ifconfig ipconfig nc ncat telnet ftp mosh openssl
git gh glab hub git-lfs tig lazygit delta npm npx pnpm pnpx yarn bun bunx node deno nvm fnm volta corepack tsc tsx ts-node eslint prettier biome jest vitest mocha playwright cypress prisma next vite webpack rollup esbuild turbo nx lerna python python3 py pip pip3 pipx poetry uv uvx conda mamba virtualenv pytest ruff black mypy jupyter ipython ruby gem bundle bundler rails rake irb go gofmt cargo rustc rustup java javac jar mvn gradle gradlew kotlin dotnet nuget msbuild make cmake ninja meson gcc g++ cc clang clang++ gdb lldb valgrind php composer perl lua swift xcodebuild xcrun pod flutter dart mix elixir erl ghc cabal stack zig
docker docker-compose podman buildah kubectl k9s kubectx kubens helm minikube kind k3d skaffold tilt terraform tofu terragrunt packer vagrant ansible ansible-playbook pulumi az aws gcloud gsutil firebase vercel netlify heroku fly flyctl wrangler doctl oc
winget choco scoop brew apt apt-get apt-cache dpkg snap flatpak dnf yum rpm pacman yay paru zypper apk port nix
powershell pwsh cmd wsl winpty where cygpath reg tasklist taskkill sc net netsh systeminfo setx icacls robocopy xcopy clip
tmux screen zellij fzf rg fd bat eza exa lsd zoxide z jq yq xh http https httpie tldr atuin mcfly starship direnv mise asdf just entr watchexec hyperfine tokei dust duf ncdu gdu procs sd glow gum broot yazi ranger nnn mc thefuck fuck pay-respects navi difft chezmoi stow
sudo doas su gsudo systemctl journalctl service crontab omp ghop grasshopper claude codex aider ollama task
get-childitem get-item get-content set-content add-content clear-content copy-item move-item remove-item rename-item new-item test-path resolve-path split-path join-path convert-path get-location set-location push-location pop-location get-process stop-process start-process get-service start-service stop-service restart-service get-command get-help get-history invoke-history clear-history get-member get-module import-module find-module install-module update-module get-installedmodule get-package find-package install-package uninstall-package get-date get-random get-filehash get-acl set-acl get-psdrive get-variable set-variable remove-variable get-alias set-alias new-alias remove-alias write-output write-host write-warning write-error read-host select-object where-object foreach-object sort-object group-object measure-object compare-object select-string out-file out-string out-null format-table format-list convertto-json convertfrom-json convertto-csv convertfrom-csv export-csv import-csv export-clixml import-clixml compress-archive expand-archive invoke-webrequest invoke-restmethod invoke-expression get-executionpolicy set-executionpolicy get-psreadlineoption set-psreadlineoption get-psreadlinekeyhandler set-psreadlinekeyhandler get-computerinfo get-ciminstance get-wmiobject get-winevent test-connection test-netconnection get-netipconfiguration get-nettcpconnection
gci gcm gc gl sl gi ni ri mi ci si sp gp sal gal gmo ipmo gps sps spps sasv spsv rsv select where foreach sort group measure compare sls ft fl fw ogv iwr irm iex
psql mysql sqlite3 redis-cli ffmpeg gpg pandoc adb bazel rclone yt-dlp nmap mongosh
`);
export const WRAPPERS: Set<string> = words("sudo doas gsudo winpty env command builtin time nohup nice timeout watch xargs exec");
export const SUBCOMMANDS: Record<string, Set<string>> = {
  git: words("add am apply archive bisect blame branch bundle checkout cherry cherry-pick clean clone commit config describe diff difftool fetch format-patch fsck gc grep help init log ls-files ls-remote ls-tree merge mergetool mv notes prune pull push range-diff rebase reflog remote repack reset restore revert rev-list rev-parse rm shortlog show show-ref sparse-checkout stash status submodule switch tag worktree lfs maintenance absorb"),
  gh: words("browse codespace gist issue org pr project release repo run search status variable workflow api extension alias label cache config"),
  npm: words("access audit bugs cache ci completion config dedupe deprecate diff dist-tag docs doctor edit exec explain explore fund help hook init install i install-test it link ll logout ls list outdated owner pack ping pkg prefix profile prune publish query rebuild repo restart root run run-script search set shrinkwrap star stars start stop team test t uninstall un remove rm unpublish unstar update up upgrade version view whoami why x create"),
  pnpm: words("add install i update up remove rm link unlink import rebuild prune fetch run exec dlx create test start publish pack outdated list ls why audit store env setup init patch patch-commit deploy"),
  yarn: words("add install remove upgrade up run dlx exec create init info why workspace workspaces build test start dev lint set config cache npm pack publish version plugin"),
  bun: words("run test x install i add remove rm update link unlink pm build init create upgrade outdated publish patch exec repl"),
  docker: words("attach build builder buildx commit compose container context cp create diff events exec export history image images import info inspect kill load logout logs network node pause plugin port ps pull push rename restart rm rmi run save search service stack start stats stop swarm system tag top trust unpause update version volume wait init scout debug"),
  "docker-compose": words("up down ps logs build pull push restart stop start exec run config rm top images ls watch"),
  kubectl: words("get describe apply create delete edit logs exec port-forward proxy cp run expose scale autoscale rollout set label annotate patch replace top cordon uncordon drain taint config cluster-info api-resources api-versions explain diff wait debug version kustomize events"),
  helm: words("install upgrade uninstall list ls repo search show status rollback history template lint package pull push dependency create get test env plugin"),
  terraform: words("init plan apply destroy validate fmt output show state import workspace providers refresh taint untaint graph console logout get force-unlock test version"),
  az: words("account group vm aks acr storage webapp functionapp network sql cosmosdb monitor ad role deployment resource extension config devops pipelines repos boards artifacts upgrade version"),
  aws: words("s3 s3api ec2 ecs ecr eks lambda iam cloudformation logs dynamodb rds sqs sns route53 cloudwatch ssm sts"),
  gcloud: words("config compute container projects iam storage functions run app builds sql components init info version"),
  cargo: words("build b check c clean doc new init add remove run r test t bench update search publish install uninstall fmt clippy tree vendor fix metadata"),
  go: words("build run test get install mod fmt vet clean env generate list version work tool doc"),
  dotnet: words("new restore build publish run test pack clean add remove list sln watch tool nuget ef format workload"),
  pip: words("install uninstall freeze list show check download wheel search cache index inspect"),
  poetry: words("add remove install update lock run shell build publish init new show env version export check"),
  uv: words("pip venv run sync lock add remove init tool python build publish tree export self"),
  brew: words("install uninstall reinstall upgrade update list search info doctor cleanup outdated services tap untap bundle autoremove deps uses link unlink pin unpin"),
  winget: words("install uninstall upgrade update search show list source settings export import pin configure features hash validate repair download"),
  choco: words("install uninstall upgrade list search info outdated pin source feature config"),
  scoop: words("install uninstall update list search info status bucket cleanup cache checkup config hold unhold reset which home prefix"),
  apt: words("install remove purge update upgrade full-upgrade dist-upgrade autoremove search show list policy clean autoclean"),
  dnf: words("install remove update upgrade search info list check-update clean history makecache"),
  systemctl: words("start stop restart reload status enable disable is-active is-enabled daemon-reload list-units list-unit-files mask unmask cat edit show"),
  tmux: words("new new-session attach attach-session a ls list-sessions kill-session kill-server split-window new-window select-window source-file detach rename-session"),
  omp: words("commit config models setup update plugin skill stats usage worktree git shell agents"),
  ghop: words("list show chat accept discard done undo analyze setup init doctor config"),
  wsl: new Set<string>(), code: new Set<string>(), cursor: new Set<string>(),
};
for (const [alias, original] of [["podman", "docker"], ["tofu", "terraform"], ["pip3", "pip"], ["apt-get", "apt"], ["yum", "dnf"]] as const) {
  SUBCOMMANDS[alias] = new Set(SUBCOMMANDS[original]);
}

export const SUBCOMMANDS2: Record<string, Set<string>> = {
  "git stash": words("list pop apply drop show push save clear branch"),
  "git remote": words("add remove rm rename set-url get-url show prune"),
  "git worktree": words("add list remove prune move lock unlock"),
  "git submodule": words("add update init status sync deinit foreach"),
  "git bisect": words("start good bad reset skip run log"),
  "git lfs": words("install track untrack ls-files pull push fetch migrate status"),
  "gh pr": words("create list view checkout merge diff review status close reopen edit comment checks ready"),
  "gh issue": words("create list view close reopen edit comment status develop"),
  "gh repo": words("clone create fork view list sync edit delete archive rename set-default"),
  "gh run": words("list view watch rerun cancel download"),
  "gh workflow": words("list view run enable disable"),
  "gh release": words("create list view download upload delete edit"),
  "docker compose": words("up down ps logs build pull push restart stop start exec run config rm top images ls watch"),
  "docker system": words("prune df info events"),
  "docker image": words("ls rm prune build pull push inspect tag history"),
  "docker container": words("ls rm prune exec logs inspect stop start run"),
  "docker volume": words("ls rm prune create inspect"),
  "docker network": words("ls rm prune create inspect connect disconnect"),
  "docker buildx": words("build create use ls inspect bake prune"),
  "docker context": words("ls use create rm inspect show"),
  "kubectl rollout": words("status history undo restart pause resume"),
  "kubectl config": words("get-contexts current-context use-context set-context view get-clusters"),
  "helm repo": words("add update list remove index"),
  "go mod": words("tidy init download vendor verify why graph edit"),
  "dotnet add": words("package reference"),
  "dotnet tool": words("install update uninstall list restore run"),
  "dotnet ef": words("migrations database dbcontext"),
  "npm config": words("get set list ls delete edit fix"),
  "brew services": words("list start stop restart run info cleanup"),
};
for (const sub of ["get", "describe", "delete", "logs"]) {
  SUBCOMMANDS2[`kubectl ${sub}`] = words("pods pod po deployments deployment deploy services service svc nodes node no namespaces namespace ns configmaps cm secrets ingress ing jobs cronjobs pvc pv events all statefulsets sts daemonsets ds replicasets rs endpoints hpa crd");
}
export const HOST_ARG_COMMANDS: Set<string> = words("ssh sftp mosh ping telnet nc ncat dig nslookup traceroute tracert host");
export const PATH_ARG_COMMANDS: Set<string> = words("cd pushd ls ll la cat less more head tail touch mkdir rmdir rm cp mv ln chmod chown stat file code code-insiders cursor subl vim vi nvim nano emacs micro hx source . bat eza lsd tar unzip zip open start explorer notepad");
export const GIT_REF_SUBCOMMANDS: Set<string> = words("checkout switch merge rebase branch push pull cherry-pick reset tag diff log show revert fetch");
export const PKG_ARG_SUBCOMMANDS: Record<string, Set<string>> = {};
for (const [commands, subs] of [
  ["npm pnpm yarn bun", "add install i remove rm uninstall un update up upgrade"],
  ["pip pip3 pipx uv poetry", "install uninstall add remove"],
  ["brew winget choco scoop apt apt-get dnf yum snap", "install uninstall remove purge upgrade reinstall show info"],
  ["cargo go gem", "install add get uninstall"],
  ["composer", "require remove"],
  ["pacman yay paru", "*"],
] as const) {
  for (const command of words(commands)) PKG_ARG_SUBCOMMANDS[command] = words(subs);
}
PKG_ARG_SUBCOMMANDS["dotnet add"] = words("package");
export const NPX_LIKE: Set<string> = new Set(["npx", "bunx", "pnpx", "uvx", "pnpm dlx", "yarn dlx", "bun x", "npm exec", "npm x"]);
export const NPX_KNOWN: Set<string> = words("create-react-app create-next-app create-vite degit npm-check-updates ncu serve http-server json-server tsc tsx prisma eslint prettier jest vitest playwright cypress turbo nx lerna husky lint-staged rimraf cross-env concurrently nodemon pm2 sort-package-json ng expo wrangler vercel netlify");
export const COMMON_SCRIPTS: Set<string> = words("dev start build test lint format fmt typecheck check serve watch preview deploy clean e2e test:unit test:e2e test:watch lint:fix storybook release prepare generate codegen migrate seed");
export const COMMON_TARGETS: Set<string> = words("all build test clean install run dev lint fmt format check deploy release docs serve watch up down");
export const PY_MODULES: Set<string> = words("pip venv http.server pytest json.tool unittest pdb timeit cProfile black ruff mypy ensurepip site");
export const SAFE_ENV_NAMES: Set<string> = words("NODE_ENV DEBUG CI PORT LOG_LEVEL RUST_LOG RUST_BACKTRACE GOOS GOARCH CGO_ENABLED PATH TERM LANG LC_ALL EDITOR PAGER FORCE_COLOR NO_COLOR TZ");
export const SAFE_LITERALS: Set<string> = words(". .. - -- ~ ~/ / HEAD @ @{u} @{upstream} FETCH_HEAD ORIG_HEAD origin upstream main master develop dev trunk staging production release");
export const SAFE_LITERAL_RES: RegExp[] = [/^HEAD(~\d{1,3}|\^{1,3})$/, /^(\.\.\/)+\.\.\/?$/];
export const FILE_EXTENSIONS: Set<string> = words("js mjs cjs ts tsx jsx json md txt yml yaml toml ini cfg conf env lock sh bash zsh ps1 bat cmd py rb go rs java kt c h cpp hpp cs fs css scss html xml sql csv log png jpg svg gz tgz zip tar exe dll so dylib");
export const PUBLIC_HOSTS: Set<string> = words("github.com api.github.com raw.githubusercontent.com gist.github.com gitlab.com bitbucket.org npmjs.com www.npmjs.com registry.npmjs.org nodejs.org pypi.org files.pythonhosted.org crates.io docs.rs rubygems.org hub.docker.com docker.io registry-1.docker.io ghcr.io quay.io mcr.microsoft.com learn.microsoft.com microsoft.com brew.sh formulae.brew.sh stackoverflow.com developer.mozilla.org google.com bun.sh deno.land go.dev golang.org pkg.go.dev rust-lang.org python.org kubernetes.io helm.sh terraform.io aws.amazon.com cloud.google.com azure.microsoft.com localhost");
export const TOOL_PROBES: Set<string> = words("fzf rg fd bat eza lsd zoxide jq yq delta lazygit tig gh glab tldr atuin mcfly starship direnv mise asdf just watchexec entr hyperfine tokei dust duf ncdu gdu btop htop procs sd xh http glow gum broot yazi thefuck pay-respects navi difft chezmoi tmux zellij nvim hx micro fnm volta pnpm bun uv pipx");
export const PACKAGE_MANAGER_PROBES: Set<string> = words("winget choco scoop npm pnpm bun brew apt dnf pacman cargo pipx");
export const COMMON_LONG_FLAGS: Set<string> = words(`--help --version --verbose --quiet --silent --force --dry-run --all --global --save --save-dev --save-exact --no-save --production --frozen-lockfile --legacy-peer-deps --recursive --interactive --amend --no-edit --no-verify --force-with-lease --force-if-includes --hard --soft --mixed --oneline --graph --decorate --stat --cached --staged --rebase --ff-only --no-ff --squash --abort --continue --skip --prune --tags --depth --branch --set-upstream --set-upstream-to --track --list --delete --system --local --name-only --name-status --pretty --format --follow --patch --watch --build --detach --rm --tty --privileged --volume --publish --env --env-file --network --name --file --tag --target --platform --no-cache --pull --remove-orphans --namespace --context --output --selector --all-namespaces --kubeconfig --insecure --location --include --exclude --ignore-case --line-number --color --no-color --human-readable --long --reverse --sort --in-place --parents --exec --type --max-depth --follow-tags --no-pager --upgrade --user --requirement --editable --index --exact --source --id --accept-package-agreements --accept-source-agreements --scope --registry --fix --write --check --coverage --open --port --host --mode --config --debug --trace --inspect --require --import --eval --print --message --grep --author --since --until --no-check-certificate --password-stdin --with-token --recurse-submodules --single-branch --unset --get --replace-all --show-origin`);
const POWERSHELL_FLAGS = words(`-path -literalpath -destination -recurse -force -filter -include -exclude -name -fullname -directory -file -hidden -attributes -depth -first -last -skip -unique -property -expandproperty -descending -ascending -casesensitive -raw -encoding -delimiter -append -nonewline -noprofile -nologo -noninteractive -executionpolicy -command -commandwithargs -inputobject -argumentlist -workingdirectory -passthru -wait -process -id -erroraction -warningaction -informationaction -verbose -debug -whatif -confirm -help -version -uri -method -headers -body -contenttype -outfile -infile -credential -usedefaultcredentials -usebasicparsing -timeoutsec -maximumredirection -skipcertificatecheck -allowunencryptedauthentication -computername -count -quiet -parallel -throttlelimit -scriptblock -begin -end -displayname -scope -value -description -option -definition -module -listavailable -online -examples -detailed -full -width -autosize -wrap -notypeinformation -compressionlevel -itemtype -pattern -simplematch -allmatches -context -editmode -key -function`);
for (const flag of POWERSHELL_FLAGS) COMMON_LONG_FLAGS.add(flag);

const knownWords = new Set([
  ...COMMANDS,
  ...Object.values(SUBCOMMANDS).flatMap(set => [...set]),
  ...Object.values(SUBCOMMANDS2).flatMap(set => [...set]),
  ...COMMON_SCRIPTS, ...COMMON_TARGETS, ...PY_MODULES, ...NPX_KNOWN,
  ...SAFE_ENV_NAMES, ...SAFE_LITERALS,
]);

export function isKnownWord(w: string): boolean {
  return knownWords.has(w) || loadConfig().privacy.allowWords.includes(w);
}
