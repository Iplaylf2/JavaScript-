import { PushStream, Cancel, EmitType, transfer } from "collection-query";
import { create, filter, scan, map, take } from "collection-query/push";

export function throttle<T>(
  t: number,
  option = { leading : true, trailing : false }
): (s: PushStream<T>) => PushStream<T> {
  const { leading, trailing } = option;
  if (trailing) {
    return throttleWithTrailing(t, leading);
  } else {
    if (leading) {
      return throttleLeading(t);
    } else {
      return take<any>(0);
    }
  }
}

class Throttle<T> {
  constructor(span: number) {
    this.span = span;
    this._sleep = true;
  }

  async cycle() {
    this._sleep = false;
    this._catchLeading = false;
    this._catchTrailing = false;
    await this.delay();
    this._sleep = true;
  }

  leading() {
    this._catchLeading = true;
  }

  pushTrailing(x: T) {
    this._catchTrailing = true;
    this._trailing = x;
  }

  popTrailing() {
    const x = this._trailing;
    this._trailing = undefined;
    return x;
  }

  get sleep() {
    return this._sleep;
  }

  get catchLeading() {
    return this._catchLeading;
  }

  get catchTrailing() {
    return this._catchTrailing;
  }

  private delay() {
    return new Promise((r) => setTimeout(r, this.span));
  }

  private span: number;
  private _sleep: boolean;
  private _catchLeading!: boolean;
  private _catchTrailing!: boolean;
  private _trailing!: T;
}

function throttleWithTrailing<T>(
  span: number,
  leading: boolean
): (s: PushStream<T>) => PushStream<T> {
  if (span <= 0) {
    return (s) => s;
  }

  return function (s) {
    return function (receiver, expose): Cancel {
      const cancel = function () {
        relay_cancel();
        source_cancel();
      };

      let source_cancel!: Cancel;

      const throttle = new Throttle<T>(span);
      const relay_emitter = create<T>((emit) => {
        s(
          (t, x?) => {
            switch (t) {
              case EmitType.Next:
                if (throttle.sleep) {
                  (async () => {
                    while (true) {
                      await throttle.cycle();
                      if (throttle.catchTrailing) {
                        emit(t, throttle.popTrailing());
                      } else if (!throttle.catchLeading) {
                        return;
                      }
                    }
                  })();

                  if (leading) {
                    throttle.leading();
                    emit(t, x);
                  } else {
                    throttle.pushTrailing(x);
                  }
                } else {
                  if (leading && !throttle.catchLeading) {
                    throttle.leading();
                    emit(t, x);
                  } else {
                    throttle.pushTrailing(x);
                  }
                }
                break;
              case EmitType.Complete:
                if (!throttle.sleep && throttle.catchTrailing) {
                  emit(EmitType.Next, throttle.popTrailing());
                }
                emit(t);
                break;
              case EmitType.Error:
                emit(t, x);
                break;
            }
          },
          (c) => {
            source_cancel = c;
          }
        );
      });

      let relay_cancel!: Cancel;

      relay_emitter(receiver, (c) => {
        relay_cancel = c;

        if (expose) {
          expose(cancel);
        }
      });

      return cancel;
    };
  };
}

function throttleLeading<T>(span: number) {
  type Item = [{ until: number }, boolean, T];
  return function (s: PushStream<T>): PushStream<T> {
    return transfer(s, [
      scan<T, Item>(
        ([context], x) => {
          const now = performance.now();
          if (context.until < now) {
            let until = context.until + span;
            if (until < now) {
              until = context.until + now;
            }
            context.until = until;
            return [context, true, x];
          } else {
            return [context, false, x];
          }
        },
        [{ until: 0 }] as any
      ),
      filter<Item>(([, test]) => test),
      map(([, , x]: Item) => x),
    ]);
  };
}
