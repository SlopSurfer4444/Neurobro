"""Explicit parallel-mode guest entry; all dependencies supplied by pinned host.

No I/O on import. The legacy client retains its default path. This mode uses
one caller-owned supervisor relay and distinct App Server children inside the
one client unit; final receipt does not assert outer relay settlement.
"""
import time

PROTOCOL = 'standing-parallel-epoch-v1'
SCHEMA = 'decadans.rm0032.standing-parallel-epoch.v1'


def run(client, modules, sources, config, receive, emit, ports=None, *,
        work_profile=None, parallel_options=None):
    value = dict(schema=SCHEMA,outcome='refused',code='CONFIG_REFUSED',stage='validate',
                 injectedPorts=ports is not None,custodyChildren=[],pool=None)
    pool = None
    cleanup_deadline = None
    clock = time.monotonic
    try:
        client.require(type(parallel_options) is dict and set(parallel_options)=={'analysisWorkers','communityAssessment'})
        width, assessor = parallel_options['analysisWorkers'], parallel_options['communityAssessment']
        client.require(type(assessor) is bool and type(width) is int and 1<=width<=7-int(assessor))
        client.require(ports is None or client.exact(ports,{'clock','popen','preflight','relay_reachable'}) and all(callable(v) for v in ports.values()))
        clock = time.monotonic if ports is None else ports['clock']
        session = modules['parallelSession']
        _, _, conversation_names = client.conversation_configuration(work_profile)
        names = {'conversation':conversation_names,'history-analysis':client.ANALYSIS_TOOL_NAMES,
                 **({'community-assessment':()} if assessor else {})}

        def factory(*,tool,clock):
            nonlocal pool
            kwargs = {} if ports is None else {'popen':ports['popen'],
                        'preflight':lambda result:ports['preflight'](modules['custody'],result)}
            pool = modules['parallelAdapter'].create_guest_pool(modules['parallelPool'],client,modules,sources,config,
                       enabled=True,epoch_ref=(config['root'][len('/run/decadans-standing-epoch-'):] if config['root'].startswith('/run/decadans-standing-epoch-') else config['root'].rsplit('/',1)[-1]),analysis_workers=width,
                       community_assessment=assessor,work_profile=work_profile,tool=tool,clock=clock,**kwargs)
            original_open = pool.open
            def open_and_publish():
                value['stage']='launch'
                original_open()
                value['custodyChildren']=pool.custody_snapshot()
                value['stage']='custody'
                client.require(emit({'kind':'poolCustodyReady','proof':value['custodyChildren']},pool.budget.remaining(20)) is True,
                               'TRANSPORT_UNKNOWN',True)
                value['stage']='session'
                return pool
            pool.open=open_and_publish
            return pool

        def validate(purpose,text):
            if purpose=='history-analysis': return client.validate_analysis_input(text)
            if purpose=='community-assessment': return client.validate_community_input(text)
            client.validate_request({'requestRef':'validation','conversation':text})
            return True

        def checked_receive(seconds):
            frame=receive(seconds)
            return session.IDLE if frame is client.IDLE else frame

        closed=session.run_parallel_session(factory,checked_receive,emit,validate,tool_names=names,clock=clock)
        value['pool']=closed['receipt']
        value['sessionCode']=closed['code']
        if 'sessionFailure' in closed:value['sessionFailure']=closed['sessionFailure']
        okay = (closed['code'] in ('CLOSED','EPOCH_LIMIT','TURN_LIMIT') and value['pool'] is not None and
                value['pool']['resourcesSettled'] and all(c['pendingOutcome'] in (None,'not-admitted') for c in value['pool']['children']))
        value.update(outcome='observed' if okay else 'unknown',code='OK' if okay else 'SESSION_UNKNOWN',stage='complete' if okay else 'session')
    except Exception:
        value.update(outcome='unknown' if pool is not None else 'refused',code='INTERNAL_UNKNOWN' if pool is not None else 'CONFIG_REFUSED')
    finally:
        if pool is not None:
            try: value['pool']=pool.close()
            except Exception: value.update(outcome='unknown',code='SHUTDOWN_UNKNOWN',stage='shutdown')
            actual_end=getattr(pool,'cleanup_deadline',None)
            cleanup_deadline=clock()+max(0,actual_end-time.monotonic()) if actual_end is not None else clock()
            if value['pool'] is None or not value['pool']['resourcesSettled']:
                value.update(outcome='unknown',code='SHUTDOWN_UNKNOWN',stage='shutdown')
    return client.normalize_parallel_result(value),cleanup_deadline,clock
