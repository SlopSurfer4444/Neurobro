"""Guest composition for the opt-in pool using existing pinned native engines.

No I/O on import; callers explicitly load/verify source modules, then call open.
This replaces the guest App Server creation seam only. It does not run the outer
supervisor, create a relay, alter production protocol, or admit live work.
"""
import subprocess
import copy
import time


def create_guest_pool(pool_module, client, modules, sources, config, *, enabled,
                      epoch_ref, analysis_workers, tool, popen=subprocess.Popen,
                      clock=time.monotonic, preflight=None, community_assessment=False,
                      work_profile=None):
    """Return unopened pool; one preflight, same relay, exact captured children.

client/modules/sources are the output of the existing pinned load_sources gate.
    tool(binding,nativeParams,seconds) is a trusted host bridge. It must route using the
complete binding to the immutable parallel work reservation, never v1 exact-head
analysis attempts. This adapter exposes analysis-only tools on analysis children.
"""
    need = pool_module.require
    need(enabled is True and callable(tool) and callable(popen) and callable(clock))
    need(preflight is None or callable(preflight))
    base = modules['custody']
    managed = modules['managedRpc']
    budget = pool_module.SharedBudget(clock=clock)
    parent = managed.create_managed_rpc_class(modules['rpc'], modules['epochRpc'])
    shared = pool_module.create_shared_rpc_class(parent, modules['rpc'].encode_frame, budget)
    records = {}
    started = False
    preflight_result = None
    owner = None
    prep_deadline = clock()+120

    def launch(purpose, index):
        nonlocal started, preflight_result
        if not started:
            started = True
            result = base.base_result()
            (preflight or base.preflight)(result)
            preflight_result = copy.deepcopy(result)
        need(clock() < prep_deadline, 'PREFLIGHT_REFUSED')
        proc = popen(client.image_launch_argv(modules['canary'], base),
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                     cwd=config['cwd'], env=base.app_server_env(), close_fds=True, bufsize=0)
        # Capture happens in pool immediately after return. Delaying creation of
        # stderr/RPC until rpc_factory avoids losing a child on constructor error.
        return proc

    def rpc_factory(proc, shared_budget):
        records[id(proc)] = {'stderr': None, 'rpc': None}
        record = records[id(proc)]
        record['stderr'] = base.StderrDigest(proc.stderr)
        raw = shared(proc, profile='image')
        record['rpc'] = raw
        return raw

    def verify(proc, raw, purpose, seconds):
        bounded = managed.ManagedDeadlineRpc(raw, clock=clock)
        bounded.deadline = min(bounded.deadline, prep_deadline, clock()+seconds)
        custody = base.base_result()
        records[id(proc)]['custody'] = custody
        custody['controls'] = copy.deepcopy(preflight_result['controls'])
        base.protocol(bounded, custody, proc.pid)
        need(modules['canary'].custody_ready(custody), 'CUSTODY_REFUSED')
        cap, error = bounded.exchange('modelProvider/capabilities/read', {}, 20)
        need(error is None and type(cap) is dict and set(cap) == {'imageGeneration','namespaceTools','webSearch'} and
             all(type(v) is bool for v in cap.values()) and cap['imageGeneration'] and cap['webSearch'], 'CAPABILITIES_REFUSED')
        need(clock() < prep_deadline, 'CUSTODY_REFUSED')
        records[id(proc)]['proof'] = {'custody':client.project_custody(custody),
                                    'capabilities':{'checked':True,**cap}}
        return True

    def actor_factory(rpc, purpose):
        analysis = purpose == 'history-analysis'
        community = purpose == 'community-assessment'
        restricted = analysis or community
        rpc.registry = modules['idleValidator'].ScopedEpochIdleRegistry(idle_sentinel=modules['epochRpc'].IDLE,
                              clock=clock, protocol='standing-scoped-epoch-v2')
        instructions, extra_tools, _ = client.conversation_configuration(work_profile)

        def dispatch(*args):
            # Existing native actor callback is (nativeParams,seconds). The
            # mutable request never selects worker.
            worker = next(w for w in owner.workers if w['rpc'] is rpc)
            binding = worker['binding']
            need(binding is not None and binding['requestRef'] == rpc.active, 'WORK_SCOPE_REFUSED')
            return tool(dict(binding), *args)

        kwargs = dict(profile=config['profile'], cwd=config['cwd'], rpc=rpc,
                      tool_spec=client.TOOL_SPEC, tool=dispatch, clock=clock,
                      instructions=client.COMMUNITY_ASSESSMENT_INSTRUCTIONS if community else client.ANALYSIS_INSTRUCTIONS if analysis else instructions,
                      extra_tools=() if community else client.ANALYSIS_EXTRA_TOOLS if analysis else extra_tools,
                      enable_web=not restricted, tool_processing_deadline=True)
        if restricted:
            kwargs.update(thread_config={'web_search':'disabled', 'features.image_generation':False})
        if community:
            kwargs['isolation_mode'] = 'community-assessment'
        actor = modules['epoch'].create_native_image_epoch(modules['native'], modules['collector'], sources['canary'], **kwargs)
        if community:
            turn = actor.turn
            def assessment_turn(request_ref, text, *args, **kwargs):
                packet = client.community_assessment_packet(text)
                need(packet['assessmentRef'] == request_ref, 'INPUT_REFUSED')
                value = turn(request_ref, text, *args, **kwargs)
                if value.get('metadata',{}).get('outcome') == 'observed':
                    need(client.validate_community_decision(value.get('answer'),packet), 'RESULT_UNKNOWN')
                return value
            actor.turn = assessment_turn
        return actor

    def prepare_turn(worker, seconds):
        raw, registry = worker['raw'], worker['rpc'].registry
        end = clock()+seconds
        # Zero-wait fast path still uses the reviewed sole reader and exact idle
        # registry. Partial frames then receive a bounded joined poll.
        while clock() < end:
            frame = raw.poll_frame(0)
            if frame is modules['epochRpc'].IDLE:
                state = raw.idle_state()
                if state == {'partialBytes':0,'queuedFrames':0,'pendingRequests':0,'stdoutEofObserved':False}:
                    return True
                return registry.poll(raw,min(1,end-clock())) == 'clear'
            registry.route(frame)
        return False

    def settle(proc, raw, seconds):
        end = time.monotonic()+seconds
        left = lambda: max(0.0, end-time.monotonic())
        result = dict(stdinClosed=False, stdoutEof=False, reaped=False, stderrJoined=False, exitCode=None)
        record = records.get(id(proc), {})
        # A failed rpc_factory may already have captured its own transport.
        raw = raw or record.get('rpc')
        if raw is not None:
            try:
                raw.close_input()
                result['stdinClosed'] = raw.metadata()['inputClosed'] is True
                if left() > 0:
                    result['stdoutEof'] = raw.drain_to_eof(min(35, left())) is True
            except Exception:
                pass
        else:
            try:
                proc.stdin.close()
                result['stdinClosed'] = proc.stdin.closed is True
            except Exception:
                pass
        try:
            if left() > 0: proc.wait(timeout=left())
            result['exitCode'] = proc.poll()
            result['reaped'] = result['exitCode'] is not None
        except Exception:
            pass
        stderr = record.get('stderr')
        if stderr is not None:
            stderr.thread.join(min(.5, left()))
            result['stderrJoined'] = not stderr.thread.is_alive() and not stderr.failed and stderr.count <= 65536
        if raw is not None:
            try: raw.close()
            except Exception: result['stdoutEof'] = False
        else:
            try: proc.stdout.close()
            except Exception: pass
        # The digest thread owns stderr until joined. EOF alone does not close
        # its FileIO handle; never close a descriptor under a live reader.
        if stderr is None or not stderr.thread.is_alive():
            try: proc.stderr.close()
            except Exception: result['stderrJoined'] = False
        return result

    def startup_context(worker):
        # Fixed diagnostic vocabulary only; no stderr, exception/probe output,
        # account data, URLs or filesystem paths enter the receipt.
        record = records.get(id(worker['proc']), {})
        result = dict(custodyStage=None, probeIndex=None, rpcFailure=None)
        custody = record.get('custody')
        if type(custody) is dict:
            stage = custody.get('stage')
            if stage in ('initialize','profile','probes','account','models'):
                result['custodyStage'] = stage
            if stage == 'probes':
                failed = [i for i,p in enumerate(custody['probes']) if p['attempted'] and p['verdict'] != 'pass']
                if failed: result['probeIndex'] = failed[0]
        raw = record.get('rpc')
        if raw is not None:
            failure = raw.metadata().get('firstFailure')
            if (type(failure) is dict and set(failure) == {'code','site','operation','phase'} and
                    failure['code'] in client.RPC_CODES and failure['code'] != 'OK' and
                    failure['site'] in client.RPC_SITES and failure['operation'] in client.RPC_OPERATIONS and
                    failure['phase'] in ('custody','model','poisoned','shutdown')):
                result['rpcFailure'] = copy.deepcopy(failure)
        return result

    def turn_failure_context(worker, value):
        diagnostics = {'nativeFailure': None}
        client.NativeFailureRecorder(diagnostics, ('conversation','history-analysis','community-assessment')).capture(value, worker['purpose'])
        return dict(nativeFailure=diagnostics['nativeFailure'], rpcFailure=startup_context(worker)['rpcFailure'])

    owner = pool_module.NativeWorkerPool(enabled=enabled, epoch_ref=epoch_ref,
             analysis_workers=analysis_workers, launch=launch, rpc_factory=rpc_factory,
             verify=verify, actor_factory=actor_factory, settle=settle, budget=budget,
             community_assessment=community_assessment, prepare_turn=prepare_turn,
             startup_context=startup_context, turn_failure_context=turn_failure_context)
    def custody_snapshot():
        with owner.lock:
            need(owner.opened and not owner.closing, 'STATE_REFUSED')
            return [dict(workerId=worker['id'],processId=worker['proc'].pid,purpose=worker['purpose'],
                         **copy.deepcopy(records[id(worker['proc'])]['proof'])) for worker in owner.workers]
    owner.custody_snapshot = custody_snapshot
    return owner
