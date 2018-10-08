"use strict";

/**
 * Constructor for emulator instances.
 *
 * Usage: `var emulator = new V86Starter(options);`
 *
 * Options can have the following properties (all optional, default in parenthesis):
 *
 * - `memory_size number` (16 * 1024 * 1024) - The memory size in bytes, should
 *   be a power of 2.
 * - `vga_memory_size number` (8 * 1024 * 1024) - VGA memory size in bytes.
 *
 * - `autostart boolean` (false) - If emulation should be started when emulator
 *   is ready.
 *
 * - `disable_keyboard boolean` (false) - If the keyboard should be disabled.
 * - `disable_mouse boolean` (false) - If the mouse should be disabled.
 *
 * - `network_relay_url string` (No network card) - The url of a server running
 *   websockproxy. See [networking.md](networking.md). Setting this will
 *   enable an emulated network card.
 *
 * - `bios Object` (No bios) - Either a url pointing to a bios or an
 *   ArrayBuffer, see below.
 * - `vga_bios Object` (No VGA bios) - VGA bios, see below.
 * - `hda Object` (No hard drive) - First hard disk, see below.
 * - `fda Object` (No floppy disk) - First floppy disk, see below.
 * - `cdrom Object` (No CD) - See below.
 *
 * - `bzimage Object` - A Linux kernel image to boot (only bzimage format), see below.
 * - `initrd Object` - A Linux ramdisk image, see below.
 * - `bzimage_initrd_from_filesystem boolean` - Automatically fetch bzimage and
 *    initrd from the specified `filesystem`.
 *
 * - `initial_state Object` (Normal boot) - An initial state to load, see
 *   [`restore_state`](#restore_statearraybuffer-state) and below.
 *
 * - `filesystem Object` (No 9p filesystem) - A 9p filesystem, see
 *   [filesystem.md](filesystem.md).
 *
 * - `serial_container HTMLTextAreaElement` (No serial terminal) - A textarea
 *   that will receive and send data to the emulated serial terminal.
 *   Alternatively the serial terminal can also be accessed programatically,
 *   see [serial.html](../examples/serial.html).
 *
 * - `screen_container HTMLElement` (No screen) - An HTMLElement. This should
 *   have a certain structure, see [basic.html](../examples/basic.html).
 *
 * ***
 *
 * There are two ways to load images (`bios`, `vga_bios`, `cdrom`, `hda`, ...):
 *
 * - Pass an object that has a url. Optionally, `async: true` and `size:
 *   size_in_bytes` can be added to the object, so that sectors of the image
 *   are loaded on demand instead of being loaded before boot (slower, but
 *   strongly recommended for big files). In that case, the `Range: bytes=...`
 *   header must be supported on the server.
 *
 *   ```javascript
 *   // download file before boot
 *   options.bios = {
 *       url: "bios/seabios.bin"
 *   }
 *   // download file sectors as requested, size is required
 *   options.hda = {
 *       url: "disk/linux.iso",
 *       async: true,
 *       size: 16 * 1024 * 1024
 *   }
 *   ```
 *
 * - Pass an `ArrayBuffer` or `File` object as `buffer` property.
 *
 *   ```javascript
 *   // use <input type=file>
 *   options.bios = {
 *       buffer: document.all.hd_image.files[0]
 *   }
 *   // start with empty hard drive
 *   options.hda = {
 *       buffer: new ArrayBuffer(16 * 1024 * 1024)
 *   }
 *   ```
 *
 * ***
 *
 * @param {Object} options Options to initialize the emulator with.
 * @constructor
 */
function V86Starter(options)
{
    //var worker = new Worker("src/browser/worker.js");
    //var adapter_bus = this.bus = WorkerBus.init(worker);

    this.cpu_is_running = false;

    const bus = Bus.create();
    const adapter_bus = this.bus = bus[0];
    this.emulator_bus = bus[1];

    var cpu;
    var wasm_memory;

    const wasm_table = new WebAssembly.Table({ element: "anyfunc", "initial": WASM_TABLE_SIZE + WASM_TABLE_OFFSET });

    const wasm_shared_funcs = {
        "cpu_exception_hook": (n) => {
            return this["cpu_exception_hook"] && this["cpu_exception_hook"](n);
        },
        "hlt_op": function() { return cpu.hlt_op(); },
        "abort": function() { dbg_assert(false); },
        "logop": function(eip, op) { return cpu.debug.logop(eip, op); },
        "undefined_instruction": function() { return cpu.undefined_instruction.apply(cpu, arguments); },
        "unimplemented_sse": function() { return cpu.unimplemented_sse(); },
        "microtick": v86.microtick,
        "get_rand_int": function() { return v86util.get_rand_int(); },
        "has_rand_int": function() { return v86util.has_rand_int(); },
        "dbg_trace": function()
        {
            dbg_trace();
        },

        "far_jump": function(eip, selector, is_call) { return cpu.far_jump(eip, selector, !!is_call); },
        "far_return": function(eip, selector, stack_adjust) { return cpu.far_return(eip, selector, stack_adjust); },
        "iret16": function() { return cpu.iret16(); },
        "iret32": function() { return cpu.iret32(); },
        "pic_acknowledge": function() { cpu.pic_acknowledge(); },

        "io_port_read8": function(addr) { return cpu.io.port_read8(addr); },
        "io_port_read16": function(addr) { return cpu.io.port_read16(addr); },
        "io_port_read32": function(addr) { return cpu.io.port_read32(addr); },
        "io_port_write8": function(addr, value) { cpu.io.port_write8(addr, value); },
        "io_port_write16": function(addr, value) { cpu.io.port_write16(addr, value); },
        "io_port_write32": function(addr, value) { cpu.io.port_write32(addr, value); },

        "mmap_read8": function(addr) { return cpu.mmap_read8(addr); },
        "mmap_read16": function(addr) { return cpu.mmap_read16(addr); },
        "mmap_read32": function(addr) { return cpu.mmap_read32(addr); },
        "mmap_write8": function(addr, value) { cpu.mmap_write8(addr, value); },
        "mmap_write16": function(addr, value) { cpu.mmap_write16(addr, value); },
        "mmap_write32": function(addr, value) { cpu.mmap_write32(addr, value); },
        "mmap_write128": function(addr, value0, value1, value2, value3) {
            cpu.mmap_write128(addr, value0, value1, value2, value3);
        },

        "arpl": function() { return cpu.arpl.apply(cpu, arguments); },

        "lar": function() { return cpu.lar.apply(cpu, arguments); },
        "lsl": function() { return cpu.lsl.apply(cpu, arguments); },
        "verw": function() { return cpu.verw.apply(cpu, arguments); },
        "verr": function() { return cpu.verr.apply(cpu, arguments); },

        "cpuid": function() { return cpu.cpuid.apply(cpu, arguments); },

        "load_ldt": function() { return cpu.load_ldt.apply(cpu, arguments); },
        "load_tr": function() { return cpu.load_tr.apply(cpu, arguments); },

        "lss16": function() { return cpu.lss16.apply(cpu, arguments); },
        "lss32": function() { return cpu.lss32.apply(cpu, arguments); },
        "enter16": function() { return cpu.enter16.apply(cpu, arguments); },
        "enter32": function() { return cpu.enter32.apply(cpu, arguments); },

        "Math_atan2": Math.atan2,
        "Math_tan": Math.tan,
        // https://github.com/rust-lang/rust/blob/56e46255b39058725d25e74200e03c0c70a0d0d3/src/etc/wasm32-shim.js#L105-L117
        "ldexp": function(x, exp) {
            return x * Math.pow(2, exp);
        },

        "log_from_wasm": function(offset, len) {
            const str = v86util.read_sized_string_from_mem(wasm_memory, offset, len);
            dbg_log(str, LOG_CPU);
        },
        "console_log_from_wasm": function(offset, len) {
            const str = v86util.read_sized_string_from_mem(wasm_memory, offset, len);
            console.error(str);
        },

        "codegen_finalize": (wasm_table_index, start, end, first_opcode, state_flags) => {
            cpu.codegen_finalize(wasm_table_index, start, end, first_opcode, state_flags);
        },
        "jit_clear_func": (wasm_table_index) => cpu.jit_clear_func(wasm_table_index),
        "do_task_switch": (selector, has_error_code, error_code) => {
            cpu.do_task_switch(selector, has_error_code, error_code);
        },
        // XXX: Port to Rust
        "switch_cs_real_mode": (selector) => cpu.switch_cs_real_mode(selector),

        "__indirect_function_table": wasm_table,
    };

    let v86oxide_bin = DEBUG ? "v86oxide-debug.wasm" : "v86oxide.wasm";

    if(options["oxide_path"])
    {
        v86oxide_bin = options["oxide_path"];
    }
    else if(typeof window === "undefined" && typeof __dirname === "string")
    {
        v86oxide_bin = __dirname + "/" + v86oxide_bin;
    }
    else
    {
        v86oxide_bin = "build/" + v86oxide_bin;
    }

    v86util.load_wasm(
        v86oxide_bin,
        { "env": wasm_shared_funcs },
        v86oxide => {
            v86oxide.exports["rust_setup"]();

            wasm_memory = v86oxide.exports.memory;

            const wm = v86oxide;

            const emulator = this.v86 = new v86(this.emulator_bus, wm, v86oxide);
            cpu = emulator.cpu;

            this.continue_init(emulator, options);
    });
}

V86Starter.prototype.continue_init = function(emulator, options)
{
    this.bus.register("emulator-stopped", function()
    {
        this.cpu_is_running = false;
    }, this);

    this.bus.register("emulator-started", function()
    {
        this.cpu_is_running = true;
    }, this);

    var settings = {};

    this.disk_images = {
        "fda": undefined,
        "fdb": undefined,
        "hda": undefined,
        "hdb": undefined,
        "cdrom": undefined,
    };

    settings.load_devices = true;
    settings.log_level = options["log_level"];
    settings.memory_size = options["memory_size"] || 64 * 1024 * 1024;
    settings.vga_memory_size = options["vga_memory_size"] || 8 * 1024 * 1024;
    settings.boot_order = options["boot_order"] || 0x213;
    settings.fda = undefined;
    settings.fdb = undefined;
    settings.cmdline = options["cmdline"];

    if(options["network_relay_url"])
    {
        this.network_adapter = new NetworkAdapter(options["network_relay_url"], this.bus);
        settings.enable_ne2k = true;
    }

    if(!options["disable_keyboard"])
    {
        this.keyboard_adapter = new KeyboardAdapter(this.bus);
    }
    if(!options["disable_mouse"])
    {
        this.mouse_adapter = new MouseAdapter(this.bus, options["screen_container"]);
    }

    if(options["screen_container"])
    {
        this.screen_adapter = new ScreenAdapter(options["screen_container"], this.bus);
    }
    else if(options["screen_dummy"])
    {
        this.screen_adapter = new DummyScreenAdapter(this.bus);
    }

    if(options["serial_container"])
    {
        this.serial_adapter = new SerialAdapter(options["serial_container"], this.bus);
    }

    // ugly, but required for closure compiler compilation
    function put_on_settings(name, buffer)
    {
        switch(name)
        {
            case "hda":
                settings.hda = this.disk_images["hda"] = buffer;
                break;
            case "hdb":
                settings.hdb = this.disk_images["hdb"] = buffer;
                break;
            case "cdrom":
                settings.cdrom = this.disk_images["cdrom"] = buffer;
                break;
            case "fda":
                settings.fda = this.disk_images["fda"] = buffer;
                break;
            case "fdb":
                settings.fdb = this.disk_images["fdb"] = buffer;
                break;

            case "multiboot":
                settings.multiboot = this.disk_images["multiboot"] = buffer.buffer;
                break;
            case "bzimage":
                settings.bzimage = this.disk_images["bzimage"] = buffer.buffer;
                break;
            case "initrd":
                settings.initrd = this.disk_images["initrd"] = buffer.buffer;
                break;

            case "bios":
                settings.bios = buffer.buffer;
                break;
            case "vga_bios":
                settings.vga_bios = buffer.buffer;
                break;
            case "initial_state":
                settings.initial_state = buffer.buffer;
                break;
            case "fs9p_json":
                settings.fs9p_json = buffer;
                break;
            default:
                dbg_assert(false, name);
        }
    }

    var files_to_load = [];

    function add_file(name, file)
    {
        if(!file)
        {
            return;
        }

        if(file["get"] && file["set"] && file["load"])
        {
            files_to_load.push({
                name: name,
                loadable: file,
            });
            return;
        }

        // Anything coming from the outside world needs to be quoted for
        // Closure Compiler compilation
        file = {
            buffer: file["buffer"],
            async: file["async"],
            url: file["url"],
            size: file["size"],
        };

        if(name === "bios" || name === "vga_bios" ||
            name === "initial_state" || name === "multiboot" ||
            name === "bzimage" || name === "initrd")
        {
            // Ignore async for these because they must be availabe before boot.
            // This should make result.buffer available after the object is loaded
            file.async = false;
        }

        if(file.buffer instanceof ArrayBuffer)
        {
            var buffer = new SyncBuffer(file.buffer);
            files_to_load.push({
                name: name,
                loadable: buffer,
            });
        }
        else if(typeof File !== "undefined" && file.buffer instanceof File)
        {
            // SyncFileBuffer:
            // - loads the whole disk image into memory, impossible for large files (more than 1GB)
            // - can later serve get/set operations fast and synchronously
            // - takes some time for first load, neglectable for small files (up to 100Mb)
            //
            // AsyncFileBuffer:
            // - loads slices of the file asynchronously as requested
            // - slower get/set

            // Heuristics: If file is larger than or equal to 256M, use AsyncFileBuffer
            if(file.async === undefined)
            {
                file.async = file.buffer.size >= 256 * 1024 * 1024;
            }

            if(file.async)
            {
                var buffer = new v86util.AsyncFileBuffer(file.buffer);
            }
            else
            {
                var buffer = new v86util.SyncFileBuffer(file.buffer);
            }

            files_to_load.push({
                name: name,
                loadable: buffer,
            });
        }
        else if(file.url)
        {
            if(file.async)
            {
                var buffer = new v86util.AsyncXHRBuffer(file.url, file.size);
                files_to_load.push({
                    name: name,
                    loadable: buffer,
                });
            }
            else
            {
                files_to_load.push({
                    name: name,
                    url: file.url,
                    size: file.size,
                });
            }
        }
        else
        {
            dbg_log("Ignored file: url=" + file.url + " buffer=" + file.buffer);
        }
    }

    if(options["state"])
    {
        console.warn("Warning: Unknown option 'state'. Did you mean 'initial_state'?");
    }

    var image_names = [
        "bios", "vga_bios",
        "cdrom", "hda", "hdb", "fda", "fdb",
        "initial_state", "multiboot",
        "bzimage", "initrd",
    ];

    for(var i = 0; i < image_names.length; i++)
    {
        add_file(image_names[i], options[image_names[i]]);
    }

    if(options["filesystem"])
    {
        var fs_url = options["filesystem"]["basefs"];
        var base_url = options["filesystem"]["baseurl"];

        const fileStorage = typeof indexedDB === "undefined" ?
            new MemoryFileStorage(base_url) :
            new IndexedDBFileStorage(base_url);
        this.fs9p = new FS(fileStorage);
        settings.fs9p = this.fs9p;

        if(fs_url)
        {
            console.assert(base_url, "Filesystem: baseurl must be specified");

            var size;

            if(typeof fs_url === "object")
            {
                size = fs_url["size"];
                fs_url = fs_url["url"];
            }
            dbg_assert(typeof fs_url === "string");

            files_to_load.push({
                name: "fs9p_json",
                url: fs_url,
                size: size,
                as_text: true,
            });
        }
    }

    var starter = this;
    var total = files_to_load.length;

    var cont = function(index)
    {
        if(index === total)
        {
            setTimeout(done.bind(this), 0);
            return;
        }

        var f = files_to_load[index];

        if(f.loadable)
        {
            f.loadable.onload = function(e)
            {
                put_on_settings.call(this, f.name, f.loadable);
                cont(index + 1);
            }.bind(this);
            f.loadable.load();
        }
        else
        {
            v86util.load_file(f.url, {
                done: function(result)
                {
                    put_on_settings.call(this, f.name, f.as_text ? result : new SyncBuffer(result));
                    cont(index + 1);
                }.bind(this),
                progress: function progress(e)
                {
                    if(e.target.status === 200)
                    {
                        starter.emulator_bus.send("download-progress", {
                            file_index: index,
                            file_count: total,
                            file_name: f.url,

                            lengthComputable: e.lengthComputable,
                            total: e.total || f.size,
                            loaded: e.loaded,
                        });
                    }
                    else
                    {
                        starter.emulator_bus.send("download-error", {
                            file_index: index,
                            file_count: total,
                            file_name: f.url,
                            request: e.target,
                        });
                    }
                },
                as_text: f.as_text,
            });
        }
    }.bind(this);
    cont(0);

    function done()
    {
        //if(settings.initial_state)
        //{
        //    // avoid large allocation now, memory will be restored later anyway
        //    settings.memory_size = 0;
        //}

        if(settings.fs9p && settings.fs9p_json)
        {
            if(!settings.initial_state)
            {
                settings.fs9p.OnJSONLoaded(settings.fs9p_json);
            }
            else
            {
                dbg_log("Filesystem basefs ignored: Overridden by state image");
            }

            if(options["bzimage_initrd_from_filesystem"])
            {
                const { bzimage, initrd } = this.get_bzimage_initrd_from_filesystem(settings.fs9p);

                dbg_log("Found bzimage: " + bzimage + " and initrd: " + initrd);

                Promise.all([
                    settings.fs9p.read_file(initrd),
                    settings.fs9p.read_file(bzimage),
                ]).then(([initrd, bzimage]) => {
                    put_on_settings.call(this, "initrd", new SyncBuffer(initrd.buffer));
                    put_on_settings.call(this, "bzimage", new SyncBuffer(bzimage.buffer));
                    finish.call(this);
                });
            }
            else
            {
                finish.call(this);
            }
        }
        else
        {
            console.assert(
                !options["bzimage_initrd_from_filesystem"],
                "bzimage_initrd_from_filesystem: Requires a filesystem");
            finish.call(this);
        }

        function finish()
        {
            this.bus.send("cpu-init", settings);

            if(settings.initial_state)
            {
                emulator.restore_state(settings.initial_state);

                // The GC can't free settings, since it is referenced from
                // several closures. This isn't needed anymore, so we delete it
                // here
                settings.initial_state = undefined;
            }

            if(options["autostart"])
            {
                this.bus.send("cpu-run");
            }

            this.emulator_bus.send("emulator-loaded");
        }
    }
};

V86Starter.prototype.get_bzimage_initrd_from_filesystem = function(filesystem)
{
    const root = (filesystem.read_dir("/") || []).map(x => "/" + x);
    const boot = (filesystem.read_dir("/boot/") || []).map(x => "/boot/" + x);

    let initrd;
    let bzimage;

    for(let f of [].concat(root, boot))
    {
        const old = /old/.test(f) || /fallback/.test(f);
        const is_bzimage = /vmlinuz/.test(f);
        const is_initrd = /initrd/.test(f) || /initramfs/.test(f);

        if(is_bzimage && (!bzimage || !old))
        {
            bzimage = f;
        }

        if(is_initrd && (!initrd || !old))
        {
            initrd = f;
        }
    }

    if(!initrd || !bzimage)
    {
        console.log("Failed to find bzimage or initrd in filesystem. Files:");
        console.log(root.join(" "));
        console.log(boot.join(" "));
    }

    return { initrd, bzimage };
};

/**
 * Start emulation. Do nothing if emulator is running already. Can be
 * asynchronous.
 * @export
 */
V86Starter.prototype.run = function()
{
    this.bus.send("cpu-run");
};

/**
 * Stop emulation. Do nothing if emulator is not running. Can be asynchronous.
 * @export
 */
V86Starter.prototype.stop = function()
{
    this.bus.send("cpu-stop");
};

/**
 * @ignore
 * @export
 */
V86Starter.prototype.destroy = function()
{
    this.keyboard_adapter.destroy();
};

/**
 * Restart (force a reboot).
 * @export
 */
V86Starter.prototype.restart = function()
{
    this.bus.send("cpu-restart");
};

/**
 * Add an event listener (the emulator is an event emitter). A list of events
 * can be found at [events.md](events.md).
 *
 * The callback function gets a single argument which depends on the event.
 *
 * @param {string} event Name of the event.
 * @param {function(*)} listener The callback function.
 * @export
 */
V86Starter.prototype.add_listener = function(event, listener)
{
    this.bus.register(event, listener, this);
};

/**
 * Remove an event listener.
 *
 * @param {string} event
 * @param {function(*)} listener
 * @export
 */
V86Starter.prototype.remove_listener = function(event, listener)
{
    this.bus.unregister(event, listener);
};

/**
 * Restore the emulator state from the given state, which must be an
 * ArrayBuffer returned by
 * [`save_state`](#save_statefunctionobject-arraybuffer-callback).
 *
 * Note that the state can only be restored correctly if this constructor has
 * been created with the same options as the original instance (e.g., same disk
 * images, memory size, etc.).
 *
 * Different versions of the emulator might use a different format for the
 * state buffer.
 *
 * @param {ArrayBuffer} state
 * @export
 */
V86Starter.prototype.restore_state = function(state)
{
    this.v86.restore_state(state);
};

/**
 * Asynchronously save the current state of the emulator. The first argument to
 * the callback is an Error object if something went wrong and is null
 * otherwise.
 *
 * @param {function(Object, ArrayBuffer)} callback
 * @export
 */
V86Starter.prototype.save_state = function(callback)
{
    // Might become asynchronous at some point

    setTimeout(function()
    {
        try
        {
            callback(null, this.v86.save_state());
        }
        catch(e)
        {
            callback(e, null);
        }
    }.bind(this), 0);
};

/**
 * Return an object with several statistics. Return value looks similar to
 * (but can be subject to change in future versions or different
 * configurations, so use defensively):
 *
 * ```javascript
 * {
 *     "cpu": {
 *         "instruction_counter": 2821610069
 *     },
 *     "hda": {
 *         "sectors_read": 95240,
 *         "sectors_written": 952,
 *         "bytes_read": 48762880,
 *         "bytes_written": 487424,
 *         "loading": false
 *     },
 *     "cdrom": {
 *         "sectors_read": 0,
 *         "sectors_written": 0,
 *         "bytes_read": 0,
 *         "bytes_written": 0,
 *         "loading": false
 *     },
 *     "mouse": {
 *         "enabled": true
 *     },
 *     "vga": {
 *         "is_graphical": true,
 *         "res_x": 800,
 *         "res_y": 600,
 *         "bpp": 32
 *     }
 * }
 * ```
 *
 * @deprecated
 * @return {Object}
 * @export
 */
V86Starter.prototype.get_statistics = function()
{
    console.warn("V86Starter.prototype.get_statistics is deprecated. Use events instead.");

    var stats = {
        cpu: {
            instruction_counter: this.get_instruction_counter(),
        },
    };

    if(!this.v86)
    {
        return stats;
    }

    var devices = this.v86.cpu.devices;

    if(devices.hda)
    {
        stats.hda = devices.hda.stats;
    }

    if(devices.cdrom)
    {
        stats.cdrom = devices.cdrom.stats;
    }

    if(devices.ps2)
    {
        stats["mouse"] = {
            "enabled": devices.ps2.use_mouse,
        };
    }

    if(devices.vga)
    {
        stats["vga"] = {
            "is_graphical": devices.vga.stats.is_graphical,
        };
    }

    return stats;
};

/**
 * @return {number}
 * @ignore
 * @export
 */
V86Starter.prototype.get_instruction_counter = function()
{
    if(this.v86)
    {
        return this.v86.cpu.timestamp_counter[0];
    }
    else
    {
        // TODO: Should be handled using events
        return 0;
    }
};

/**
 * @return {boolean}
 * @export
 */
V86Starter.prototype.is_running = function()
{
    return this.cpu_is_running;
};

/**
 * Send a sequence of scan codes to the emulated PS2 controller. A list of
 * codes can be found at http://stanislavs.org/helppc/make_codes.html.
 * Do nothing if there is no keyboard controller.
 *
 * @param {Array.<number>} codes
 * @export
 */
V86Starter.prototype.keyboard_send_scancodes = function(codes)
{
    for(var i = 0; i < codes.length; i++)
    {
        this.bus.send("keyboard-code", codes[i]);
    }
};

/**
 * Send translated keys
 * @ignore
 * @export
 */
V86Starter.prototype.keyboard_send_keys = function(codes)
{
    for(var i = 0; i < codes.length; i++)
    {
        this.keyboard_adapter.simulate_press(codes[i]);
    }
};

/**
 * Send text
 * @ignore
 * @export
 */
V86Starter.prototype.keyboard_send_text = function(string)
{
    for(var i = 0; i < string.length; i++)
    {
        this.keyboard_adapter.simulate_char(string[i]);
    }
};

/**
 * Download a screenshot.
 *
 * @ignore
 * @export
 */
V86Starter.prototype.screen_make_screenshot = function()
{
    if(this.screen_adapter)
    {
        this.screen_adapter.make_screenshot();
    }
};

/**
 * Set the scaling level of the emulated screen.
 *
 * @param {number} sx
 * @param {number} sy
 *
 * @ignore
 * @export
 */
V86Starter.prototype.screen_set_scale = function(sx, sy)
{
    if(this.screen_adapter)
    {
        this.screen_adapter.set_scale(sx, sy);
    }
};

/**
 * Go fullscreen.
 *
 * @ignore
 * @export
 */
V86Starter.prototype.screen_go_fullscreen = function()
{
    if(!this.screen_adapter)
    {
        return;
    }

    var elem = document.getElementById("screen_container");

    if(!elem)
    {
        return;
    }

    // bracket notation because otherwise they get renamed by closure compiler
    var fn = elem["requestFullScreen"] ||
            elem["webkitRequestFullscreen"] ||
            elem["mozRequestFullScreen"] ||
            elem["msRequestFullScreen"];

    if(fn)
    {
        fn.call(elem);

        // This is necessary, because otherwise chromium keyboard doesn't work anymore.
        // Might (but doesn't seem to) break something else
        var focus_element = document.getElementsByClassName("phone_keyboard")[0];
        focus_element && focus_element.focus();
    }

    //this.lock_mouse(elem);
    this.lock_mouse();
};

/**
 * Lock the mouse cursor: It becomes invisble and is not moved out of the
 * browser window.
 *
 * @ignore
 * @export
 */
V86Starter.prototype.lock_mouse = function()
{
    var elem = document.body;

    var fn = elem["requestPointerLock"] ||
                elem["mozRequestPointerLock"] ||
                elem["webkitRequestPointerLock"];

    if(fn)
    {
        fn.call(elem);
    }
};

/**
 * Enable or disable sending mouse events to the emulated PS2 controller.
 *
 * @param {boolean} enabled
 */
V86Starter.prototype.mouse_set_status = function(enabled)
{
    if(this.mouse_adapter)
    {
        this.mouse_adapter.emu_enabled = enabled;
    }
};

/**
 * Enable or disable sending keyboard events to the emulated PS2 controller.
 *
 * @param {boolean} enabled
 * @export
 */
V86Starter.prototype.keyboard_set_status = function(enabled)
{
    if(this.keyboard_adapter)
    {
        this.keyboard_adapter.emu_enabled = enabled;
    }
};


/**
 * Send a string to the first emulated serial terminal.
 *
 * @param {string} data
 * @export
 */
V86Starter.prototype.serial0_send = function(data)
{
    for(var i = 0; i < data.length; i++)
    {
        this.bus.send("serial0-input", data.charCodeAt(i));
    }
};

/**
 * Mount another filesystem to the current filesystem.
 * @param {string} path Path for the mount point
 * @param {string|undefined} baseurl
 * @param {string|undefined} basefs As a JSON string
 * @param {function(Object)=} callback
 * @export
 */
V86Starter.prototype.mount_fs = function(path, baseurl, basefs, callback)
{
    const fileStorage = typeof indexedDB === "undefined" ?
        new MemoryFileStorage(baseurl) :
        new IndexedDBFileStorage(baseurl);
    const newfs = new FS(fileStorage, this.fs9p.qidcounter);
    const mount = () =>
    {
        const idx = this.fs9p.Mount(path, newfs);
        if(!callback)
        {
            return;
        }
        if(idx === -ENOENT)
        {
            callback(new FileNotFoundError());
        }
        else if(idx === -EEXIST)
        {
            callback(new FileExistsError());
        }
        else if(idx < 0)
        {
            dbg_assert(false, "Unexpected error code: " + (-idx));
            callback(new Error("Failed to mount. Error number: " + (-idx)));
        }
        else
        {
            callback(null);
        }
    };
    if(baseurl)
    {
        dbg_assert(typeof basefs === "string", "Filesystem: basefs must be a JSON string");
        newfs.OnJSONLoaded(basefs);
        newfs.OnLoaded = mount;
    }
    else
    {
        mount();
    }
};

/**
 * Write to a file in the 9p filesystem. Nothing happens if no filesystem has
 * been initialized. First argument to the callback is an error object if
 * something went wrong and null otherwise.
 *
 * @param {string} file
 * @param {Uint8Array} data
 * @param {function(Object)=} callback
 * @export
 */
V86Starter.prototype.create_file = function(file, data, callback)
{
    callback = callback || function() {};

    var fs = this.fs9p;

    if(!fs)
    {
        return;
    }

    var parts = file.split("/");
    var filename = parts[parts.length - 1];

    var path_infos = fs.SearchPath(file);
    var parent_id = path_infos.parentid;
    var not_found = filename === "" || parent_id === -1;

    if(!not_found)
    {
        fs.CreateBinaryFile(filename, parent_id, data)
            .then(() => callback(null));
    }
    else
    {
        setTimeout(function()
        {
            callback(new FileNotFoundError());
        }, 0);
    }
};

/**
 * Read a file in the 9p filesystem. Nothing happens if no filesystem has been
 * initialized.
 *
 * @param {string} file
 * @param {function(Object, Uint8Array)} callback
 * @export
 */
V86Starter.prototype.read_file = function(file, callback)
{
    var fs = this.fs9p;

    if(!fs)
    {
        return;
    }

    fs.read_file(file).then((result) => {
        if(result)
        {
            callback(null, result);
        }
        else
        {
            callback(new FileNotFoundError(), null);
        }
    });
};

/**
 * @ignore
 * @constructor
 *
 * @param {string=} message
 */
function FileExistsError(message)
{
    this.message = message || "File already exists";
}
FileExistsError.prototype = Error.prototype;

/**
 * @ignore
 * @constructor
 *
 * @param {string=} message
 */
function FileNotFoundError(message)
{
    this.message = message || "File not found";
}
FileNotFoundError.prototype = Error.prototype;

// Closure Compiler's way of exporting
if(typeof window !== "undefined")
{
    window["V86Starter"] = V86Starter;
    window["V86"] = V86Starter;
}
else if(typeof module !== "undefined" && typeof module.exports !== "undefined")
{
    module.exports["V86Starter"] = V86Starter;
    module.exports["V86"] = V86Starter;
}
else if(typeof importScripts === "function")
{
    // web worker
    self["V86Starter"] = V86Starter;
    self["V86"] = V86Starter;
}
