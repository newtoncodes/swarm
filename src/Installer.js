'use strict';

const os = require('os');
const exists = require('fs').existsSync;
const readFile = require('fs').readFileSync;
const writeFile = require('fs').writeFileSync;
const mkdir = require('fs').mkdirSync;
const unlink = require('fs').unlinkSync;
const chmod = require('fs').chmodSync;
const exec = require('child_process').execSync;
const dotenv = require('dotenv');
const Utils = require('./Utils');


class Installer {
    constructor() {
        if (exists('/etc/docker-hive/hive.conf')) {
            try {
                this._config = dotenv.parse(readFile('/etc/docker-hive/hive.conf'));
            } catch (e) {
                this._config = {};
            }
        }
    
        let env = {};
        
        if (exists('/etc/docker-hive/env.conf')) {
            try {
                env = dotenv.parse(readFile('/etc/docker-hive/env.conf'));
            } catch (e) {
                env = {};
            }
        }
    
        this._type = env['type'];
        this._host = env['host'];
        this._gateway = env['gateway'];
    }
    
    async init(host, iface) {
        if (!exists('/etc/docker-hive')) mkdir('/etc/docker-hive');
        if (!exists('/etc/docker-hive/vpn')) mkdir('/etc/docker-hive/vpn');
        if (exists('/etc/docker-hive/env.conf')) throw new Error('Already in a swarm. Run hive leave first.');
    
        let config = {};
        if (exists('/etc/docker-hive/hive.conf')) {
            try {
                config = dotenv.parse(readFile('/etc/docker-hive/hive.conf'));
            } catch (e) {
                config = {};
            }
        }
        
        try {
            if (!host) host = await Utils.get('api.ipify.org', 80, '/');
        } catch (e) {}
        
        host = await askHost(host);
        iface = await askIface(iface);
    
        let iptablesCallback = await askIptablesCallback(config['iptablesCallback']);
    
        let apiKey = config['apiKey'];
        let apiSecret = config['apiSecret'];
        if (!apiKey || apiKey.length !== 128 || !apiSecret || apiSecret.length !== 128 || 'yes' === await askRegenerateApi()) {
            apiKey = await generateToken(128);
            apiSecret = await generateToken(128);
        }
        
        let adminUsername = await askAdminUsername(config['adminUsername']);
        let adminPassword = await askAdminPassword(config['adminPassword']);
        let slackKey = await askSlackKey(config['slackKey']);
        let slackChannel = await askSlackChannel(config['slackChannel']);
        let slackUsername = await askSlackUsername(config['slackUsername']);
        let publishPorts = await askPublishPorts(config['publishPorts']);

        writeFile('/etc/docker-hive/hive.conf', `# Hive API key and secret
apiKey=${apiKey}
apiSecret=${apiSecret}

# Grafana/portainer root user and password
adminUsername=${adminUsername}
adminPassword=${adminPassword}

# Prometheus notifications
slackKey=${slackKey}
slackChannel=${slackChannel}
slackUsername=${slackUsername}

# Publish portainer, grafana and prometheus ports
publishPorts=${publishPorts === 'yes' ? '1' : '0'}

# Advertise network interface
iface=${iface}

# Callback command to execute when iptables rules get updated
iptablesCallback="${iptablesCallback}"
`);
        chmod('/etc/docker-hive/hive.conf', 0o600);
    
        try {exec('docker swarm leave --force', {stdio: [null, null, 'ignore']});} catch (e) {}
        exec('docker swarm init --advertise-addr ' + host);
        
        let gateway = await getGateway();
    
        rmVolume('hive_portainer');
        rmVolume('hive_prometheus');
        rmVolume('hive_prometheus_rules');
        rmVolume('hive_alertmanager');
        rmVolume('hive_grafana');
        rmVolume('hive_grafana_log');
        rmVolume('hive_grafana_etc');
        
        rmNetwork('hive');
    
        createNetwork('hive');
        
        createVolume('hive_portainer');
        createVolume('hive_prometheus');
        createVolume('hive_prometheus_rules');
        createVolume('hive_alertmanager');
        createVolume('hive_grafana');
        createVolume('hive_grafana_log');
        createVolume('hive_grafana_etc');
        
        writeFile('/etc/docker/daemon.json', '{"experimental": true, "metrics-addr": "' + gateway + ':9323"}');
        exec('service docker restart', {stdio: 'inherit'});
        
        writeFile('/etc/docker-hive/env.conf', `# Environment variables. Please don't change these manually.
type=master
host=${host}
gateway=${gateway}
`);
        chmod('/etc/docker-hive/env.conf', 0o600);
        
        console.log('Swarm created.');
    
        exec('bash ' + __dirname + '/../bin/install.sh', {stdio: 'inherit'});
        if (exists('/etc/init.d/docker-hive')) try {
            exec('/etc/init.d/docker-hive start', {stdio: 'inherit'});
        } catch(e) {}
    }
    
    async join (type, host, iface) {
        if (!exists('/etc/docker-hive')) mkdir('/etc/docker-hive');
        if (!exists('/etc/docker-hive/vpn')) mkdir('/etc/docker-hive/vpn');
        if (exists('/etc/docker-hive/env.conf')) throw new Error('Already in a swarm. Run hive leave first.');
    
        let config = {};
        if (exists('/etc/docker-hive/hive.conf')) {
            try {
                config = dotenv.parse(readFile('/etc/docker-hive/hive.conf'));
            } catch (e) {
                config = {};
            }
        }
        
        type = await askType(type);
        host = await askHost2(host);
        iface = await askIface(iface);
        
        let iptablesCallback = await askIptablesCallback(config['iptablesCallback']);
        let apiKey = await askApiKey(config['apiKey']);
        let apiSecret = await askApiSecret(config['apiSecret']);
    
        writeFile('/etc/docker-hive/hive.conf', `# Hive API key and secret
apiKey=${apiKey}
apiSecret=${apiSecret}

# Advertise network interface
iface=${iface}

# Callback command to execute when iptables rules get updated
iptablesCallback="${iptablesCallback}"
`);
        chmod('/etc/docker-hive/hive.conf', 0o600);
        
        let token = null;
        try {
            token = await Utils.post(host, 4876, '/token-' + type, apiKey);
        } catch (e) {
            token = null;
        }
        
        if (!token) throw new Error('Cannot get token. Check your host address.');
        
        try {
            token = Utils.decrypt(token, apiSecret);
        } catch (e) {
            token = null;
        }
    
        if (!token) throw new Error('Cannot decrypt token. Check your credentials.');
    
        try {exec('docker swarm leave --force', {stdio: [null, null, 'ignore']});} catch (e) {}
        exec('docker swarm join --token "' + token + '" "' + host + ':2377"');
        
        let gateway = await getGateway();
    
        writeFile('/etc/docker/daemon.json', '{"experimental": true, "metrics-addr": "' + gateway + ':9323"}');
        exec('/etc/init.d/docker restart');
        
        writeFile('/etc/docker-hive/env.conf', `# Environment variables. Please don't change these manually.
type=${type}
host=${host}
gateway=${gateway}
`);
        chmod('/etc/docker-hive/env.conf', 0o600);
        
        console.log('Joined to swarm successfully.');
    
        exec('bash ' + __dirname + '/../bin/install.sh', {stdio: 'inherit'});
        if (exists('/etc/init.d/docker-hive')) try {
            exec('/etc/init.d/docker-hive start', {stdio: 'inherit'});
        } catch(e) {}
    }
    
    async leave() {
        if (!exists('/etc/docker-hive/env.conf')) throw new Error('This node is not connected to a swarm.');
        if (exists('/etc/init.d/docker-hive')) try {
            exec('/etc/init.d/docker-hive stop', {stdio: 'inherit'});
        } catch(e) {}
        
        if (this._type === 'master') {
            rmVolume('hive_portainer');
            rmVolume('hive_prometheus');
            rmVolume('hive_prometheus_rules');
            rmVolume('hive_alertmanager');
            rmVolume('hive_grafana');
            rmVolume('hive_grafana_log');
            rmVolume('hive_grafana_etc');
            
            rmNetwork('hive');
        }
    
        if (exists('/etc/docker-hive/env.conf')) unlink('/etc/docker-hive/env.conf');
        if (exists('/etc/docker-hive/nodes')) unlink('/etc/docker-hive/nodes');
        exec('docker swarm leave --force');
        
        console.log('Left the swarm successfully.');
    }
    
    async reset() {
        this._checkMaster();
        
        if (!exists('/etc/docker-hive/env.conf')) throw new Error('This node is not connected to a swarm.');
        
        console.log('Resetting hive...');
        
        rmVolume('hive_portainer');
        rmVolume('hive_prometheus');
        rmVolume('hive_prometheus_rules');
        rmVolume('hive_alertmanager');
        rmVolume('hive_grafana');
        rmVolume('hive_grafana_log');
        rmVolume('hive_grafana_etc');
        
        createVolume('hive_portainer');
        createVolume('hive_prometheus');
        createVolume('hive_prometheus_rules');
        createVolume('hive_alertmanager');
        createVolume('hive_grafana');
        createVolume('hive_grafana_log');
        createVolume('hive_grafana_etc');
        
        console.log('Hive reset successfully.');
    }
    
    _checkMaster() {
        if (this._type !== 'master') throw new Error('You can only do this on the master machine.');
    }
    
    _checkManagerWorker() {
        if (this._type === 'master') throw new Error('You cannot do this on the master machine.');
    }
}


const askType = async (initial) => {
    let a = await Utils.ask(`Node type - manager or worker${initial ? ` (${initial})` : ''}: `, n => {
        return n.toLowerCase() === 'manager' || n.toLowerCase() === 'worker';
    }, undefined, initial);
    
    return a.toLowerCase();
};

const askHost = async (initial) => {
    return await Utils.ask(`Public IPv4 address to advertise${initial ? ` (${initial})` : ''}: `, n => {
        return (n && !!n.match(/^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/));
    }, undefined, initial);
};

const askHost2 = async (initial) => {
    return await Utils.ask(`Public IPv4 address of the master node${initial ? ` (${initial})` : ''}: `, n => {
        return (n && !!n.match(/^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/));
    }, undefined, initial);
};

const askIptablesCallback = async (initial) => {
    return await Utils.ask('Bash command to run on iptables rules change: ', () => true, undefined, initial);
};

const askRegenerateApi = async () => {
    let a = await Utils.ask(`Hive key and secret already found. Do you want to generate new ones - yes or no? (no): `, n => {
        return n.toLowerCase() === 'yes' || n.toLowerCase() === 'no';
    }, undefined, 'no');
    
    return a.toLowerCase();
};

const askApiKey = async (initial) => {
    return await Utils.ask(`Hive key${initial ? ` (use previous)` : ''}: `, n => {
        return n && n.length === 128;
    }, undefined, initial);
};

const askApiSecret = async (initial) => {
    return await Utils.ask(`Hive secret${initial ? ` (use previous)` : ''}: `, n => {
        return n && n.length === 128;
    }, undefined, initial);
};

const askAdminUsername = async (initial) => {
    return await Utils.ask(`Admin username${initial ? ` (${initial})` : ''}: `, n => {
        return n && n.length > 3;
    }, undefined, initial);
};

const askAdminPassword = async (initial) => {
    return await Utils.ask(`Admin password${initial ? ` (${initial})` : ''}: `, () => true, undefined, initial);
};

const askSlackKey = async (initial) => {
    return await Utils.ask(`Slack key${initial ? ` (${initial})` : ''}: `, () => true, undefined, initial);
};

const askSlackChannel = async (initial) => {
    return await Utils.ask(`Slack channel${initial ? ` (${initial})` : ''}: `, () => true, undefined, initial);
};

const askSlackUsername = async (initial) => {
    return await Utils.ask(`Slack username${initial ? ` (${initial})` : ''}: `, () => true, undefined, initial);
};

const askPublishPorts = async (initial) => {
    let a = await Utils.ask(`Publish ports - yes or no${initial ? ` (${initial === '1' || initial === 'y' || initial === 'yes' ? 'yes' : 'no'})` : ' (no)'}: `, n => {
        return n.toLowerCase() === 'yes' || n.toLowerCase() === 'no';
    }, undefined, initial === '1' || initial === 'y' || initial === 'yes' ? 'yes' : 'no');
    
    return a.toLowerCase();
};

const askIface = async (iface) => {
    let interfaces = Object.keys(os.networkInterfaces()).filter(i => {
        return (
            i !== 'lo' &&
            i !== 'docker0' &&
            i.indexOf('docker_') !== 0 &&
            i.indexOf('br-') !== 0 &&
            i.indexOf('veth') !== 0
        )
    });
    
    if (!interfaces.length) {
        throw new Error('No active network interfaces found.');
    }
    
    if (!iface && interfaces.length === 1) iface = interfaces[0];
    
    return await Utils.ask(`Public network interface to advertise${iface ? ` (${iface})` : ''}: `, n => {
        return (n && interfaces.includes(n));
    }, null, iface);
};

let getGateway = async () => {
    let hostIp = null;
    let retries = 0;
    
    while (!hostIp) {
        if (retries > 30) throw new Error('Cannot find docker_gwbridge interface.');
        retries ++;
        
        await new Promise(resolve => setTimeout(() => resolve(), 1000));
        
        try {
            hostIp = (exec('ip -o addr show docker_gwbridge | awk \'{print $4}\'', {stdio: ['pipe', 'pipe', 'pipe']}) || '')['toString']('utf8').trim().split(/\s+/)[0].split('/')[0];
        } catch (e) {
            hostIp = null;
        }
    }
    
    return hostIp;
};

const generateToken = async (length) => {
    return await new Promise(resolve => {
        require('crypto').randomBytes(length * 3, function(err, buffer) {
            resolve(buffer['toString']('base64').replace(/\W/g, '').replace(/[^a-zA-Z0-9]/g, '').substr(0, length));
        });
    });
}


const existsVolume = (name) => {
    let id = '';
    
    try {
        id = (exec('docker volume ls -q --filter="name=' + name + '"') || '')['toString']('utf8').trim();
    } catch (e) {
        id = '';
    }
    
    return id.length > 0;
};

const createVolume = (name) => {
    if (existsVolume(name)) throw new Error('Volume "' + name + '" already exists.');
    
    try {
        exec('docker volume create ' + name);
    } catch (e) {
        throw new Error('Could not create volume "' + name + '"');
    }
};

const rmVolume = (name) => {
    if (!existsVolume(name)) return;
    
    try {
        exec('docker volume rm ' + name);
    } catch (e) {
        throw new Error('Could not remove volume "' + name + '"');
    }
};


const existsNetwork = (name) => {
    let id = '';
    
    try {
        id = (exec('docker network ls -q --filter="name=' + name + '"') || '')['toString']('utf8').trim();
    } catch (e) {
        id = '';
    }
    
    return id.length > 0;
};

const createNetwork = (name) => {
    if (existsNetwork(name)) throw new Error('Network "' + name + '" already exists.');
    
    try {
        exec('docker network create --attachable -d overlay ' + name);
    } catch (e) {
        throw new Error('Could not create network "' + name + '"');
    }
};

const rmNetwork = (name) => {
    if (!existsNetwork(name)) return;
    
    try {
        exec('docker network rm ' + name);
    } catch (e) {
        throw new Error('Could not remove network "' + name + '"');
    }
};


module.exports = Installer;