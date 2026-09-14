"""Real epoch/native/collector with bounded in-memory host and fake native RPC."""
import base64
import copy
import importlib.util
import json
from pathlib import Path
import queue
import threading
import time
import unittest

ROOT = Path(__file__).parent
def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module
s = load("session", "rm-0032-native-epoch-session.py")
f = load("fixtures", "rm-0032-native-conversation.test.py")
e = load("epoch", "rm-0032-native-image-epoch.py")
c = load("collector", "rm-0032-native-image-collector.py")
v = load("validator", "rm-0032-standing-image-client.py")
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==")
TEXT = json.dumps({"schema":"neurobro-conversation-v1","currentRequest":{"text":"Привет"},"replyChain":[],"recent":[],"contextState":{}},ensure_ascii=False)
def turn(number): return {"kind":"turn","requestRef":"request-"+str(number),"conversation":TEXT}
def validate(text): v.validate_request({"requestRef":"validation", "conversation":text}); return True
def image_plan(turn_id):
    item={"id":"image-"+turn_id,"type":"imageGeneration","status":"completed","result":base64.b64encode(PNG).decode()}
    started={**item,"status":"in_progress","result":""}
    return [{"method":"item/started","params":{"threadId":"thread-1","turnId":turn_id,"startedAtMs":1,"item":started}},
            {"method":"item/completed","params":{"threadId":"thread-1","turnId":turn_id,"completedAtMs":2,"item":item}},
            f.completed(turn_id,"Картинка",[item,f.message(turn_id,"Картинка")])]

class Host:
    def __init__(self, count=1, delivery="verified"):
        self.inbox=queue.Queue();self.frames=[];self.receivers=set();self.deadlines=[]
        self.count=count;self.delivery=delivery;self.cancelled=0;self.actor=None
        self.on_emit=None;self.closed_state=None;self.actor_hook=None
    def receive(self,seconds):
        self.receivers.add(threading.get_ident());self.deadlines.append(("read",seconds))
        try:return self.inbox.get(timeout=min(seconds,.03))
        except queue.Empty:return s.IDLE
    def emit(self,message,seconds):
        self.deadlines.append(("write",seconds));self.frames.append(copy.deepcopy(message))
        if self.on_emit and self.on_emit(message):return True
        kind=message["kind"]
        if kind=="ready":self.inbox.put(turn(1))
        elif kind=="tool":self.inbox.put({"kind":"toolResult","requestRef":message["requestRef"],"callRef":message["callRef"],"result":copy.deepcopy(f.RESULT)})
        elif kind=="completed":self.inbox.put({"kind":"release","requestRef":message["scope"]["requestRef"],"delivery":self.delivery})
        elif kind=="released" and self.delivery!="unknown":
            number=int(message["requestRef"].split("-")[-1])
            self.inbox.put(turn(number+1) if number<self.count else {"kind":"close"})
        elif kind=="closed":self.closed_state=self.actor.state()
        return True
    def cancel(self):self.cancelled+=1
    def run(self,rpc=None,clock=time.monotonic,idle=None,cancel=None,extra_tools=(),tool_names=None):
        rpc=rpc or f.Rpc()
        def factory(**ports):
            self.actor=e.create_native_image_epoch(f.m,c,f.SOURCE,profile=f.PROFILE,cwd=f.CWD,tool_spec=copy.deepcopy(f.SPEC),instructions="Neurobro answers or reads bound history or creates one image.",rpc=rpc,extra_tools=extra_tools,**ports)
            if self.actor_hook:self.actor_hook(self.actor)
            return self.actor
        return s.run_session(factory,self.receive,self.emit,idle or (lambda seconds:"clear"),validate,cancel or self.cancel,clock=clock,tool_names=tool_names),rpc

class SessionTests(unittest.TestCase):
    def test_visual_turn_crosses_real_session_into_actual_rpc_input(self):
        host=Host()
        encoded=base64.b64encode(PNG).decode()
        def hook(frame):
            if frame["kind"]=="ready":
                host.inbox.put({**turn(1),"images":[{"mimeType":"image/png","base64":encoded}]})
                return True
            return False
        host.on_emit=hook
        closed,rpc=host.run()
        self.assertEqual(closed["code"],"CLOSED")
        params=next(p for method,p in rpc.calls if method=="turn/start")
        self.assertEqual(params["input"][1]["url"],"data:image/png;base64,"+encoded)
        self.assertNotIn(encoded,json.dumps(host.frames))

    def test_named_registry_coupled_archive_schedule_history_image_and_closed_epoch(self):
        names=(f.m.NAME,"neurobro_archive","neurobro_schedule_text")
        def plan(t):
            if t=="turn-2":return image_plan(t)
            return [f.request(t,2**63-1,"history"),f.named_request(t,rpc_id="9223372036854775807"),
                    f.named_request(t,"neurobro_schedule_text",rpc_id=2**63-2,call_id="schedule"),f.completed(t)]
        host=Host(2);closed,rpc=host.run(f.Rpc(plan),extra_tools=[f.extra(),f.extra(names[2])],tool_names=names)
        self.assertEqual(closed["code"],"CLOSED")
        self.assertEqual(host.frames[0],{"kind":"ready","tools":list(names)})
        callbacks=[x for x in host.frames if x["kind"]=="tool"]
        self.assertEqual([x["name"] for x in callbacks],list(names))
        self.assertTrue(all(set(x)=={"kind","name","requestRef","callRef","arguments"} for x in callbacks))
        self.assertEqual([type(x[0]) for x in rpc.responses],[int,str,int])
        self.assertEqual([x["kindOfAnswer"] for x in host.frames if x["kind"]=="completed"],["text","image"])
        before=len(rpc.calls);value=host.actor.turn("late-request",TEXT)
        self.assertEqual(value["metadata"]["code"],"SESSION_POISONED");self.assertEqual(len(rpc.calls),before)
        self.assertNotIn("9223372036854775807",json.dumps(host.frames))

    def test_named_explicit_empty_extras_is_distinct_from_default_frames(self):
        host=Host();closed,rpc=host.run(f.Rpc(lambda t:[f.request(t),f.completed(t)]),tool_names=(f.m.NAME,))
        self.assertEqual(closed["code"],"CLOSED")
        self.assertEqual(host.frames[0],{"kind":"ready","tools":[f.m.NAME]})
        self.assertEqual(next(x for x in host.frames if x["kind"]=="tool")["name"],f.m.NAME)

    def test_registry_session_mismatch_never_emits_ready_or_admits_native_turn(self):
        for entries,names in (([f.extra()],None),([],(f.m.NAME,"neurobro_archive")),
                              ([f.extra()],(f.m.NAME,"neurobro_schedule_text"))):
            host=Host();closed,rpc=host.run(extra_tools=entries,tool_names=names)
            self.assertEqual(closed["code"],"PROTOCOL_REFUSED")
            self.assertFalse(any(x["kind"]=="ready" for x in host.frames));self.assertEqual(rpc.calls,[])
        for names in ([],(),(f.m.NAME,f.m.NAME),("neurobro_other",),(f.m.NAME,"bad"),tuple([f.m.NAME]+["neurobro_x"+str(i) for i in range(32)])):
            with self.assertRaises(ValueError):Host().run(tool_names=names)

    def test_named_callback_close_has_no_native_response_or_late_reuse(self):
        host=Host()
        def emit(message):
            if message["kind"]=="tool":host.inbox.put({"kind":"close"});return True
            return False
        host.on_emit=emit
        closed,rpc=host.run(f.Rpc(lambda t:[f.named_request(t),f.completed(t)]),extra_tools=[f.extra()],tool_names=(f.m.NAME,"neurobro_archive"))
        self.assertEqual(closed["code"],"CLOSED");self.assertEqual(rpc.responses,[])
        self.assertTrue(closed["facts"]["unreleasedTurn"])
        self.assertFalse(any(x["kind"]=="completed" for x in host.frames))

    def test_two_history_turns_nine_pages_then_image_then_text_same_thread(self):
        def plan(t):
            n=int(t.split("-")[-1])
            if n<3:
                count=8 if n==1 else 1
                return [f.request(t,2**63-1-n*20-i,"call-%s-%s"%(n,i)) for i in range(count)]+[f.completed(t)]
            return image_plan(t) if n==3 else [f.completed(t)]
        host=Host(4);closed,rpc=host.run(f.Rpc(plan))
        self.assertEqual(closed["code"],"CLOSED")
        completed=[x for x in host.frames if x["kind"]=="completed"]
        self.assertEqual([x["toolCalls"] for x in completed],[8,1,0,0])
        self.assertEqual([x["kindOfAnswer"] for x in completed],["text","text","image","text"])
        self.assertEqual([x["scope"]["turnNumber"] for x in completed],[1,2,3,4])
        self.assertEqual([x[0] for x in rpc.calls],["thread/start"]+["turn/start"]*4)
        self.assertEqual(len(rpc.responses),9);self.assertTrue(all(type(x[0]) is int and x[0]>2**53 for x in rpc.responses))
        tools=[x for x in host.frames if x["kind"]=="tool"]
        self.assertEqual(len({x["callRef"] for x in tools}),9)
        self.assertTrue(all(set(x)=={"kind","requestRef","callRef","arguments"} for x in tools))
        chunk=next(x for x in host.frames if x["kind"]=="imageChunk")
        self.assertEqual(base64.b64decode(chunk["dataBase64"]),PNG)
        self.assertFalse(closed["facts"]["resourceSettlementObserved"])
        self.assertFalse(closed["facts"]["running"]);self.assertFalse(closed["facts"]["unreleasedTurn"])
        self.assertEqual(len(host.receivers),1);self.assertNotIn(threading.get_ident(),host.receivers)
        self.assertTrue(all(0<t<=1 for kind,t in host.deadlines if kind=="read"))
        self.assertTrue(all(0<t<=20 for kind,t in host.deadlines if kind=="write"))
        with self.assertRaises(e.EpochError):host.actor.image_artifact()

    def test_mismatched_call_ref_refuses_without_native_response_or_answer(self):
        host=Host()
        def emit(message):
            if message["kind"]!="tool":return False
            host.inbox.put({"kind":"toolResult","requestRef":message["requestRef"],"callRef":"foreign","result":f.RESULT});return True
        host.on_emit=emit
        closed,rpc=host.run(f.Rpc(lambda t:[f.request(t,2**63-1),f.completed(t)]))
        self.assertEqual(closed["code"],"PROTOCOL_REFUSED");self.assertEqual(rpc.responses,[])
        self.assertFalse(any(x["kind"]=="completed" for x in host.frames))
        self.assertNotIn("foreign",json.dumps(closed));self.assertTrue(closed["facts"]["poisoned"])

    def test_next_turn_without_release_is_refused(self):
        host=Host()
        def emit(message):
            if message["kind"]=="completed":host.inbox.put(turn(2));return True
            return False
        host.on_emit=emit;closed,rpc=host.run()
        self.assertEqual(closed["code"],"PROTOCOL_REFUSED");self.assertEqual(len(rpc.calls),2)
        self.assertTrue(closed["facts"]["unreleasedTurn"])

    def test_unknown_release_ack_then_closed_no_next_turn(self):
        host=Host(delivery="unknown");closed,rpc=host.run()
        self.assertEqual(closed["code"],"RELEASE_UNKNOWN")
        self.assertEqual([x["kind"] for x in host.frames][-2:],["released","closed"])
        self.assertEqual(len(rpc.calls),2);self.assertTrue(closed["facts"]["poisoned"])

    def test_close_and_eof_interrupt_ordinary_turn_and_join_before_closed(self):
        for stop in ({"kind":"close"},None):
            with self.subTest(stop=stop):
                host=Host();resumed=threading.Event();left=threading.Event()
                class Blocking(f.Rpc):
                    def next_frame(self,seconds):
                        host.inbox.put(stop)
                        if not resumed.wait(2):raise AssertionError("cancellation not invoked")
                        left.set();raise EOFError("private native detail")
                def cancel():host.cancel();resumed.set()
                started=time.monotonic();closed,rpc=host.run(Blocking(),cancel=cancel)
                self.assertLess(time.monotonic()-started,1)
                self.assertTrue(left.is_set());self.assertEqual(host.cancelled,1)
                self.assertEqual(closed["code"],"CLOSED" if stop else "IO_UNKNOWN")
                self.assertFalse(host.closed_state["running"]);self.assertFalse(host.closed_state["busy"])
                self.assertFalse(any(x["kind"]=="completed" for x in host.frames))
                self.assertNotIn("private",json.dumps(closed))

    def test_close_during_tool_callback_cancels_without_reply(self):
        host=Host()
        def emit(message):
            if message["kind"]=="tool":host.inbox.put({"kind":"close"});return True
            return False
        host.on_emit=emit;closed,rpc=host.run(f.Rpc(lambda t:[f.request(t),f.completed(t)]))
        self.assertEqual(closed["code"],"CLOSED");self.assertEqual(rpc.responses,[])
        self.assertFalse(closed["facts"]["running"])

    def test_idle_native_failure_blocks_admission(self):
        host=Host();closed,rpc=host.run(idle=lambda seconds:"unreviewed-event")
        self.assertEqual(closed["code"],"NATIVE_UNKNOWN");self.assertEqual(rpc.calls,[])

    def test_malformed_conversation_is_not_forwarded(self):
        host=Host()
        def emit(message):
            if message["kind"]=="ready":host.inbox.put({**turn(1),"conversation":"private invalid JSON"});return True
            return False
        host.on_emit=emit;closed,rpc=host.run()
        self.assertEqual(closed["code"],"INPUT_REFUSED");self.assertEqual(rpc.calls,[])
        self.assertNotIn("private",json.dumps(closed))

    def test_emit_unknown_never_retries_completed(self):
        host=Host();original=host.emit
        def emit(message,seconds):
            if message["kind"]=="completed":host.frames.append(copy.deepcopy(message));raise OSError("secret")
            return original(message,seconds)
        host.emit=emit;closed,rpc=host.run()
        self.assertEqual(closed["code"],"IO_UNKNOWN")
        self.assertEqual(len([x for x in host.frames if x["kind"]=="completed"]),1)
        self.assertTrue(closed["facts"]["unreleasedTurn"])

    def test_epoch_insufficient_budget_never_starts_native(self):
        now=[0.0];host=Host()
        def idle(seconds):now[0]=601;return "clear"
        closed,rpc=host.run(clock=lambda:now[0],idle=idle)
        self.assertEqual(closed["code"],"EPOCH_LIMIT");self.assertEqual(rpc.calls,[])
        self.assertFalse(closed["facts"]["unreleasedTurn"])
        self.assertEqual([x for x in host.frames if x["kind"]=="notAdmitted"],
                         [{"kind":"notAdmitted","requestRef":"request-1","reason":"time","turnsAdmitted":0}])

    def test_five_released_turns_then_time_refusal_preserves_actual_native_counts(self):
        now=[0.0];host=Host(6)
        def advance(message):
            if message["kind"]=="released" and message["requestRef"]=="request-5":now[0]=600.001
            return False
        host.on_emit=advance;closed,rpc=host.run(clock=lambda:now[0])
        self.assertEqual(closed["code"],"EPOCH_LIMIT");self.assertFalse(closed["facts"]["unreleasedTurn"])
        self.assertFalse(closed["facts"]["poisoned"])
        self.assertEqual([x for x in host.frames if x["kind"]=="notAdmitted"],
                         [{"kind":"notAdmitted","requestRef":"request-6","reason":"time","turnsAdmitted":5}])
        self.assertEqual(sum(method=="thread/start" for method,_ in rpc.calls),1)
        self.assertEqual(sum(method=="turn/start" for method,_ in rpc.calls),5)
        self.assertEqual(closed["facts"]["turnsAdmitted"],5)

    def test_seventeenth_turn_is_typed_refusal_without_native_dispatch(self):
        host=Host(17);closed,rpc=host.run(clock=lambda:0)
        self.assertEqual(closed["code"],"TURN_LIMIT");self.assertFalse(closed["facts"]["unreleasedTurn"])
        self.assertEqual([x for x in host.frames if x["kind"]=="notAdmitted"],
                         [{"kind":"notAdmitted","requestRef":"request-17","reason":"turns","turnsAdmitted":16}])
        self.assertEqual(sum(method=="turn/start" for method,_ in rpc.calls),16)

    def test_refusal_validation_rejects_close_poison_mismatch_and_counter_races(self):
        for mode in ("close","poison","ref","count","bool","extra","reason"):
            with self.subTest(mode=mode):
                now=[0.0];host=Host()
                def hook(actor):
                    original=actor.turn
                    def racing(ref,text):
                        value=original(ref,text)
                        if mode=="close":actor.close()
                        elif mode=="poison":actor._poisoned=True
                        elif mode=="ref":value["requestRef"]="foreign"
                        elif mode=="count":actor._attempts+=1
                        elif mode=="bool":value["turnsAdmitted"]=False
                        elif mode=="extra":value["extra"]=True
                        else:value["reason"]="turns"
                        return value
                    actor.turn=racing
                host.actor_hook=hook
                def idle(seconds):now[0]=601;return "clear"
                closed,rpc=host.run(clock=lambda:now[0],idle=idle)
                self.assertEqual(closed["code"],"NATIVE_UNKNOWN")
                self.assertTrue(closed["facts"]["unreleasedTurn"])
                self.assertFalse(any(x["kind"]=="notAdmitted" for x in host.frames));self.assertEqual(rpc.calls,[])

    def test_legacy_session_limit_after_actual_dispatch_stays_unknown(self):
        class LegacyLimit(f.Rpc):
            def next_frame(self,seconds):raise f.m.Refused("SESSION_LIMIT","session")
        host=Host();closed,rpc=host.run(LegacyLimit())
        self.assertEqual(closed["code"],"NATIVE_UNKNOWN");self.assertTrue(closed["facts"]["unreleasedTurn"])
        self.assertTrue(closed["facts"]["poisoned"])
        self.assertEqual(sum(method=="turn/start" for method,_ in rpc.calls),1)
        self.assertFalse(any(x["kind"]=="notAdmitted" for x in host.frames))

    def test_late_tool_reply_after_completion_is_refused(self):
        host=Host();previous=[]
        def emit(message):
            if message["kind"]=="tool":previous.append(copy.deepcopy(message));return False
            if message["kind"]=="completed":
                old=previous[0];host.inbox.put({"kind":"toolResult","requestRef":old["requestRef"],"callRef":old["callRef"],"result":f.RESULT});return True
            return False
        host.on_emit=emit;closed,rpc=host.run(f.Rpc(lambda t:[f.request(t),f.completed(t)]))
        self.assertEqual(closed["code"],"PROTOCOL_REFUSED");self.assertEqual(len(rpc.responses),1)

    def test_tool_port_deadline_overrun_is_unknown_and_no_native_reply(self):
        now=[0.0];host=Host()
        def emit(message):
            if message["kind"]=="tool":
                timeout=host.deadlines[-1][1]
                self.assertGreater(timeout,0);self.assertLessEqual(timeout,20)
                now[0]+=timeout+.001
                return True
            return False
        host.on_emit=emit
        closed,rpc=host.run(f.Rpc(lambda t:[f.request(t),f.completed(t)]),clock=lambda:now[0])
        self.assertEqual(closed["code"],"IO_UNKNOWN");self.assertEqual(rpc.responses,[])
        self.assertFalse(any(x["kind"]=="completed" for x in host.frames))

    def test_untrusted_exception_code_cannot_escape_in_closed_receipt(self):
        host=Host()
        def idle(seconds):raise s.SessionStop(["private-error"])
        closed,rpc=host.run(idle=idle)
        self.assertEqual(closed["code"],"INTERNAL_UNKNOWN");self.assertNotIn("private",json.dumps(closed))

    def test_stop_at_completed_turn_return_preserves_outstanding_turn(self):
        host=Host();cancelled=threading.Event()
        def configure(actor):
            original=actor.turn
            def wrapped(*args):
                value=original(*args)
                self.assertEqual(value["metadata"]["outcome"],"observed")
                host.inbox.put({"kind":"close"})
                self.assertTrue(cancelled.wait(2))
                self.assertFalse(actor.state()["releasePending"])
                return value
            actor.turn=wrapped
        host.actor_hook=configure
        def cancel():host.cancel();cancelled.set()
        closed,rpc=host.run(cancel=cancel)
        self.assertEqual(closed["code"],"CLOSED")
        self.assertTrue(closed["facts"]["unreleasedTurn"])
        self.assertFalse(any(x["kind"]=="completed" for x in host.frames))

    def test_invalid_completed_scope_preserves_outstanding_turn(self):
        host=Host()
        def configure(actor):actor.completed_turn_scope=lambda:{"invalid":"private-scope"}
        host.actor_hook=configure;closed,rpc=host.run()
        self.assertEqual(closed["code"],"NATIVE_UNKNOWN")
        self.assertTrue(closed["facts"]["unreleasedTurn"])
        self.assertNotIn("private",json.dumps(closed))

    def test_real_native_refusal_ledger_accepts_192_and_final_poison_193(self):
        for extra in (0,1):
            with self.subTest(extra=extra):
                def plan(t):
                    n=int(t.split("-")[-1]);frames=[]
                    for i in range(12+(extra if n==16 else 0)):
                        frame=f.request(t,2**63-1-n*20-i,"call-%s-%s"%(n,i))
                        if i>=8:frame["params"]["arguments"]={}
                        frames.append(frame)
                    return frames+[f.completed(t)]
                host=Host(16);closed,rpc=host.run(f.Rpc(plan))
                self.assertEqual(closed["facts"]["toolCalls"],192+extra)
                self.assertEqual(closed["code"],"NATIVE_UNKNOWN" if extra else "CLOSED")
                self.assertEqual(len([x for x in host.frames if x["kind"]=="tool"]),128)
                self.assertEqual(len(rpc.responses),192)
                self.assertEqual(closed["facts"]["unreleasedTurn"],bool(extra))

if __name__=="__main__":unittest.main()
